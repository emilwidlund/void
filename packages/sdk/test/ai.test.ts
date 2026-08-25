import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { generateText, simulateReadableStream, streamText } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import type { AiLogEvent, MeteredOptions } from "../src/ai.js"
import { metered, modelPricing, voidOptions } from "../src/ai.js"
import type { EventNameOf, MeterIdOf } from "../src/index.js"
import { defineConfig, on, usd } from "../src/index.js"

/** Wire-level capture of everything the void client sends. */
interface SentEvent {
  name: string
  external_customer_id?: string
  properties?: Record<string, string | number | boolean>
  _cost?: { amount: number; currency: string }
}
let sent: Array<SentEvent> = []
let failTracking = false

const stubFetch = (async (_url: unknown, init?: { body?: unknown }) => {
  if (failTracking) throw new Error("proxy down")
  const body = JSON.parse(String(init?.body)) as { events: Array<SentEvent> }
  sent.push(...body.events)
  return new Response(
    JSON.stringify({ ingested: body.events.length, matched: {}, reversed: {}, cost_minor: 0 }),
    { status: 200 }
  )
}) as typeof fetch

/** An assistant declared as a meter, wired to a mock model. */
const connect = (model: MockLanguageModelV4, options?: MeteredOptions) => {
  const config = defineConfig({
    meters: {
      assistant: metered(model, options),
      requests: { filter: on("ai.assistant"), aggregate: "count" }
    },
    products: {
      pro: {
        name: "Pro",
        entitlements: { quota: { meter: "requests", limit: 100 } },
        usage: {
          "assistant.input_tokens": { perUnit: usd(0.0000035) },
          "assistant.output_tokens": { perUnit: usd(0.0000105) }
        }
      }
    }
  })
  return config.connect({ endpoint: "http://proxy", fetch: stubFetch })
}

beforeEach(() => {
  sent = []
  failTracking = false
})

const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 500, text: 500, reasoning: undefined }
}

const generateResult = (providerMetadata?: Record<string, Record<string, unknown>>) => ({
  content: [{ type: "text" as const, text: "hello" }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage,
  ...(providerMetadata !== undefined
    ? { providerMetadata: providerMetadata as never }
    : {}),
  warnings: []
})

describe("metered meters", () => {
  it("expands to one meter per token class — never a total_tokens default", () => {
    const config = defineConfig({
      meters: { assistant: metered(new MockLanguageModelV4({})) },
      products: {}
    })
    // the IR canonicalizes property paths under `event.` — same as the DSL
    expect(config.ir.meters.map((m) => [m.id, m.aggregation])).toEqual([
      ["assistant.input_tokens", { type: "sum", property: "event.input_tokens" }],
      [
        "assistant.cached_input_tokens",
        { type: "sum", property: "event.cached_input_tokens" }
      ],
      ["assistant.output_tokens", { type: "sum", property: "event.output_tokens" }]
    ])
    // all three filter on the event derived from the meter key
    expect(
      config.ir.meters.every((m) => JSON.stringify(m.filter).includes("ai.assistant"))
    ).toBe(true)
    expect(config.meters).toEqual([
      "assistant.input_tokens",
      "assistant.cached_input_tokens",
      "assistant.output_tokens"
    ])
    expect(config.events).toContain("ai.assistant")

    type C = typeof config.config
    expectTypeOf<"assistant.output_tokens">().toExtend<MeterIdOf<C>>()
    expectTypeOf<"ai.assistant">().toExtend<EventNameOf<C>>()
  })

  it("an explicit aggregate compiles to a single meter under the plain key", () => {
    const config = defineConfig({
      meters: {
        assistant: metered(new MockLanguageModelV4({}), {
          event: "chat.completed",
          aggregate: "count"
        })
      },
      products: { pro: { name: "Pro", usage: { assistant: { perUnit: usd(0.01) } } } }
    })
    expect(config.ir.meters.map((m) => [m.id, m.aggregation])).toEqual([
      ["assistant", { type: "count" }]
    ])
    expect(config.events).toContain("chat.completed")

    type C = typeof config.config
    expectTypeOf<"assistant">().toExtend<MeterIdOf<C>>()
    expectTypeOf<"chat.completed">().toExtend<EventNameOf<C>>()
  })
})

describe("client.ai · generate", () => {
  it("exposes the bound model and tracks the derived event with token properties", async () => {
    const mock = new MockLanguageModelV4({
      provider: "gateway",
      modelId: "openai/gpt-4o",
      doGenerate: generateResult({ gateway: { cost: "0.0125", generationId: "gen_1" } })
    })
    const client = connect(mock)

    const result = await generateText({
      model: client.ai.assistant,
      prompt: "hi",
      providerOptions: {
        void: voidOptions({ customer: "acme", properties: { ticket_id: "T-1" } })
      }
    })
    expect(result.text).toBe("hello")

    expect(sent).toHaveLength(1)
    const event = sent[0]!
    expect(event.name).toBe("ai.assistant") // derived from the meter key
    expect(event.external_customer_id).toBe("acme")
    expect(event.properties).toMatchObject({
      model: "openai/gpt-4o",
      provider: "gateway",
      input_tokens: 1000,
      output_tokens: 500,
      total_tokens: 1500,
      finish_reason: "stop",
      streamed: false,
      ticket_id: "T-1"
    })
    expect(event._cost).toEqual({ amount: 0.0125, currency: "USD" })

    // the void namespace never reaches the provider
    expect(mock.doGenerateCalls[0]!.providerOptions).toEqual({})
  })

  it("falls back to the pricing table when the gateway reports no cost", async () => {
    const client = connect(
      new MockLanguageModelV4({
        provider: "openai",
        modelId: "gpt-4o",
        doGenerate: generateResult()
      }),
      {
        customer: "globex",
        pricing: modelPricing({ "gpt-4o": { input: usd(2.5), output: usd(10) } })
      }
    )
    await generateText({ model: client.ai.assistant, prompt: "hi" })

    const event = sent[0]!
    expect(event.external_customer_id).toBe("globex")
    // 1000/1M * $2.50 + 500/1M * $10
    expect(event._cost!.amount).toBeCloseTo(0.0075, 10)
    expect(event._cost!.currency).toBe("USD")
  })

  it("prefers a custom cost resolver and supports per-call event override", async () => {
    const client = connect(
      new MockLanguageModelV4({
        provider: "gateway",
        modelId: "openai/gpt-4o",
        doGenerate: generateResult({ gateway: { cost: "0.0125" } })
      }),
      { cost: (info) => usd((info.usage.totalTokens ?? 0) * 0.00001) }
    )
    await generateText({
      model: client.ai.assistant,
      prompt: "hi",
      providerOptions: { void: voidOptions({ event: "ai.custom", customer: "acme" }) }
    })
    expect(sent[0]!.name).toBe("ai.custom")
    expect(sent[0]!._cost!.amount).toBeCloseTo(0.015, 10)
  })

  it("emits the full lifecycle through the log sink", async () => {
    const logged: Array<AiLogEvent> = []
    const client = connect(
      new MockLanguageModelV4({
        provider: "openai",
        modelId: "gpt-4o",
        doGenerate: generateResult()
      }),
      {
        pricing: modelPricing({ "gpt-4o": { input: usd(2.5), output: usd(10) } }),
        log: (entry) => logged.push(entry)
      }
    )

    await generateText({
      model: client.ai.assistant,
      prompt: "hi there",
      providerOptions: { void: voidOptions({ customer: "acme" }) }
    })
    expect(logged.map((entry) => entry.type)).toEqual(["call", "finish", "cost", "track"])
    expect(logged[0]).toMatchObject({
      type: "call",
      event: "ai.assistant",
      model: "gpt-4o",
      provider: "openai",
      streamed: false,
      prompt: "hi there",
      customer: "acme"
    })
    expect(logged[1]).toMatchObject({
      type: "finish",
      info: { usage: { inputTokens: 1000, outputTokens: 500 } }
    })
    expect(logged[2]).toMatchObject({ type: "cost", source: "pricing" })
    expect(logged[3]).toMatchObject({
      type: "track",
      customer: "acme",
      properties: { total_tokens: 1500 }
    })

    // opting out logs a skip; a tracking failure logs an error
    logged.length = 0
    await generateText({
      model: client.ai.assistant,
      prompt: "hi",
      providerOptions: { void: voidOptions({ track: false }) }
    })
    expect(logged.map((entry) => entry.type)).toEqual(["call", "skip"])

    logged.length = 0
    failTracking = true
    await generateText({ model: client.ai.assistant, prompt: "hi" })
    expect(logged.map((entry) => entry.type)).toEqual(["call", "finish", "cost", "error"])
  })

  it("skips tracking when the call opts out, and never breaks the model call on track errors", async () => {
    const errors: Array<unknown> = []
    const client = connect(new MockLanguageModelV4({ doGenerate: generateResult() }), {
      onTrackError: (e) => errors.push(e)
    })

    await generateText({
      model: client.ai.assistant,
      prompt: "hi",
      providerOptions: { void: voidOptions({ track: false }) }
    })
    expect(sent).toHaveLength(0)

    failTracking = true
    const result = await generateText({ model: client.ai.assistant, prompt: "hi" })
    expect(result.text).toBe("hello")
    expect(errors).toHaveLength(1)
  })
})

describe("client.ai · stream", () => {
  it("tracks once the stream finishes, from the finish part's usage and metadata", async () => {
    const parts: Array<LanguageModelV4StreamPart> = [
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", modelId: "openai/gpt-4o-2024-11-20" },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "hel" },
      { type: "text-delta", id: "1", delta: "lo" },
      { type: "text-end", id: "1" },
      {
        type: "finish",
        usage,
        finishReason: { unified: "stop", raw: "stop" },
        providerMetadata: { gateway: { cost: "0.002" } }
      }
    ]
    const client = connect(
      new MockLanguageModelV4({
        provider: "gateway",
        modelId: "openai/gpt-4o",
        doStream: { stream: simulateReadableStream({ chunks: parts }) }
      })
    )

    const result = streamText({
      model: client.ai.assistant,
      prompt: "hi",
      providerOptions: { void: voidOptions({ customer: "acme" }) }
    })
    expect(await result.text).toBe("hello")

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const event = sent[0]!
    expect(event.name).toBe("ai.assistant")
    expect(event.external_customer_id).toBe("acme")
    expect(event.properties).toMatchObject({
      model: "openai/gpt-4o-2024-11-20", // response metadata wins over the wrapped id
      streamed: true,
      total_tokens: 1500
    })
    expect(event._cost).toEqual({ amount: 0.002, currency: "USD" })
  })
})

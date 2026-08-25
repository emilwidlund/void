import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { generateText, simulateReadableStream, streamText } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import { metered, modelPricing, voidOptions } from "../src/ai.js"
import type {
  AiEventOf,
  AiPropertyKeysOf,
  ConfigShape,
  EventNameOf,
  MeterConfig
} from "../src/index.js"
import { defineConfig, on, usd } from "../src/index.js"

const config = defineConfig({
  meters: {
    ai_tokens: {
      filter: on("ai.generation"),
      aggregate: { sum: "total_tokens" }
    }
  },
  products: {
    pro: {
      name: "Pro",
      usage: { ai_tokens: { margin: "30%" } }
    }
  },
  // first-class AI: wrapped models inherit these defaults
  ai: {
    event: "ai.generation",
    properties: { source: "assistant" },
    pricing: modelPricing({ "gpt-4o": { input: usd(2.5), output: usd(10) } })
  }
})

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

const voidClient = config.connect({ endpoint: "http://proxy", fetch: stubFetch })

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

describe("ai config inference", () => {
  it("derives the ai event, its property keys, and track() autocomplete from the config", () => {
    type C = typeof config.config

    expectTypeOf<AiEventOf<C>>().toEqualTypeOf<"ai.generation">()
    // automatic middleware properties plus the declared `ai.properties` keys
    expectTypeOf<"total_tokens">().toExtend<AiPropertyKeysOf<C>>()
    expectTypeOf<"input_tokens">().toExtend<AiPropertyKeysOf<C>>()
    expectTypeOf<"source">().toExtend<AiPropertyKeysOf<C>>()

    // meters filtering on the ai event get its property keys; others don't
    type Meters = ConfigShape<C>["meters"]
    expectTypeOf<Meters["ai_tokens"]>().toEqualTypeOf<
      MeterConfig<AiPropertyKeysOf<C>>
    >()

    // an ai event not mentioned by any meter still reaches EventNameOf/events
    const embeddings = defineConfig({
      meters: { calls: { filter: on("api.request"), aggregate: "count" } },
      products: {},
      ai: { event: "ai.embedding" }
    })
    expectTypeOf<EventNameOf<typeof embeddings.config>>().toExtend<
      "api.request" | "ai.embedding"
    >()
    expect(embeddings.events).toContain("ai.embedding")

    // the connected client carries the section (defaults for `metered`)
    expect(voidClient.ai?.event).toBe("ai.generation")
  })
})

describe("metered · generate", () => {
  it("inherits event, properties and pricing from the config's ai section", async () => {
    const model = metered(
      new MockLanguageModelV4({
        provider: "openai",
        modelId: "gpt-4o",
        doGenerate: generateResult()
      }),
      { client: voidClient } // nothing else — defaults come from defineConfig
    )
    await generateText({
      model,
      prompt: "hi",
      providerOptions: { void: voidOptions({ customer: "acme" }) }
    })

    expect(sent).toHaveLength(1)
    const event = sent[0]!
    expect(event.name).toBe("ai.generation")
    expect(event.external_customer_id).toBe("acme")
    expect(event.properties).toMatchObject({ source: "assistant", total_tokens: 1500 })
    // 1000/1M * $2.50 + 500/1M * $10, from ai.pricing
    expect(event._cost!.amount).toBeCloseTo(0.0075, 10)
  })

  it("requires an event from the config or the options", () => {
    const bare = { track: () => Promise.resolve({}) }
    expect(() => metered(new MockLanguageModelV4({}), { client: bare })).toThrow(
      /no event to track/
    )
  })

  it("tracks token properties and prefers the gateway-reported cost", async () => {
    const mock = new MockLanguageModelV4({
      provider: "gateway",
      modelId: "openai/gpt-4o",
      doGenerate: generateResult({ gateway: { cost: "0.0125", generationId: "gen_1" } })
    })
    const model = metered(mock, { client: voidClient })

    const result = await generateText({
      model,
      prompt: "hi",
      providerOptions: {
        void: voidOptions({ customer: "acme", properties: { ticket_id: "T-1" } })
      }
    })
    expect(result.text).toBe("hello")

    const event = sent[0]!
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

  it("prefers a custom cost resolver and supports per-call event override", async () => {
    const model = metered(
      new MockLanguageModelV4({
        provider: "gateway",
        modelId: "openai/gpt-4o",
        doGenerate: generateResult({ gateway: { cost: "0.0125" } })
      }),
      {
        client: voidClient,
        customer: "globex",
        cost: (info) => usd((info.usage.totalTokens ?? 0) * 0.00001)
      }
    )
    await generateText({
      model,
      prompt: "hi",
      providerOptions: { void: voidOptions({ event: "ai.custom" }) }
    })
    expect(sent[0]!.name).toBe("ai.custom")
    expect(sent[0]!.external_customer_id).toBe("globex")
    expect(sent[0]!._cost!.amount).toBeCloseTo(0.015, 10)
  })

  it("skips tracking when the call opts out, and never breaks the model call on track errors", async () => {
    const errors: Array<unknown> = []
    const model = metered(new MockLanguageModelV4({ doGenerate: generateResult() }), {
      client: voidClient,
      onTrackError: (e) => errors.push(e)
    })

    await generateText({
      model,
      prompt: "hi",
      providerOptions: { void: voidOptions({ track: false }) }
    })
    expect(sent).toHaveLength(0)

    failTracking = true
    const result = await generateText({ model, prompt: "hi" })
    expect(result.text).toBe("hello")
    expect(errors).toHaveLength(1)
  })
})

describe("metered · stream", () => {
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
    const model = metered(
      new MockLanguageModelV4({
        provider: "gateway",
        modelId: "openai/gpt-4o",
        doStream: { stream: simulateReadableStream({ chunks: parts }) }
      }),
      { client: voidClient }
    )

    const result = streamText({
      model,
      prompt: "hi",
      providerOptions: { void: voidOptions({ customer: "acme" }) }
    })
    expect(await result.text).toBe("hello")

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const event = sent[0]!
    expect(event.external_customer_id).toBe("acme")
    expect(event.properties).toMatchObject({
      model: "openai/gpt-4o-2024-11-20", // response metadata wins over the wrapped id
      streamed: true,
      total_tokens: 1500
    })
    expect(event._cost).toEqual({ amount: 0.002, currency: "USD" })
  })
})

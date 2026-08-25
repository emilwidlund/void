/**
 * An app's `void.ts` — the customer state of record, as one typed config.
 *
 * Entitlements, meters and AI models are the core; billing falls out as a
 * side effect. AI is declared as a meter: `metered(model)` compiles to one
 * standard meter per token class (input, cached input, output — they price
 * differently, so there is deliberately no single-sum default), and the
 * connected client exposes the wrapped model as `voidClient.ai.assistant`.
 * Every call lands on the customer's record with token counts as properties
 * and the cost of serving it attached as `_cost` — the AI Gateway's own
 * reported cost when present, else the `pricing` rates.
 */
import { defineConfig, on, usd } from "@void/sdk"
import { metered, modelPricing, voidOptions } from "@void/sdk/ai"
import { gateway, generateText, streamText } from "ai"

export const config = defineConfig({
  meters: {
    // the AI model as a meter: usage event `ai.assistant`, expanded into
    // assistant.input_tokens / .cached_input_tokens / .output_tokens
    assistant: metered(gateway("openai/gpt-4o"), {
      // fallback cost rates (per 1M tokens); gateway-reported cost wins
      pricing: modelPricing({
        "openai/gpt-4o": { input: usd(2.5), output: usd(10) },
        "*": { input: usd(1), output: usd(3) },
      }),
    }),
    // plain meter over the same event, for the request quota
    ai_requests: { filter: on("ai.assistant"), aggregate: "count" },
  },

  products: {
    pro: {
      name: "Pro",
      price: { every: "month", amount: usd(49) },
      entitlements: {
        ai_assistant: true,
        ai_quota: { meter: "ai_requests", limit: 1_000 },
      },
      usage: {
        // token classes priced separately — the point of the expansion
        "assistant.input_tokens": { perUnit: usd(0.0000035) }, //  $3.50 / 1M
        "assistant.output_tokens": { perUnit: usd(0.0000105) }, // $10.50 / 1M
      },
    },
  },

  invariants: [
    // serving a customer below 25% margin flips enforcement to "warn"
    { name: "ai_margin_floor", assert: { margin: "customer", gte: "25%" }, else: "warn" },
  ],
})

export const voidClient = config.connect({
  endpoint: process.env.VOID_PROXY_URL ?? "http://localhost:4010",
})

// ---------------------------------------------------------------------------
// Using it: the model lives on the client, already wrapped and usage-tracked.
// Attribution rides on providerOptions — nothing else changes.
// ---------------------------------------------------------------------------

export const reply = async (customer: string, question: string) => {
  const gate = await voidClient.entitlements(customer)
  if (!gate.allowed("ai_assistant") || !gate.allowed("ai_quota")) {
    throw new Error("AI assistant not available on this plan")
  }

  const { text } = await generateText({
    model: voidClient.ai.assistant,
    prompt: question,
    providerOptions: {
      void: voidOptions({ customer, properties: { feature: "assistant" } }),
    },
  })
  // recorded: ai.assistant { customer, model, input_tokens, output_tokens,
  //           total_tokens, duration_ms, feature } + _cost from the gateway
  return text
}

export const replyStreaming = (customer: string, question: string) =>
  streamText({
    model: voidClient.ai.assistant,
    prompt: question,
    providerOptions: { void: voidOptions({ customer }) },
    // recorded once the stream finishes, from the finish part's usage;
    // aborted streams never are
  })

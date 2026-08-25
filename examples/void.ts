/**
 * An app's `void.ts` — the customer state of record, as one typed config.
 *
 * Entitlements, meters and AI usage are the core; billing falls out as a
 * side effect. The first-class `ai` section makes any model wrapped with
 * `metered` report usage automatically: every `generateText` / `streamText`
 * call lands on the customer's record with token counts as properties and
 * the cost of serving it attached as `_cost` — which powers the cost-plus
 * pricing and the margin invariant below. Cost comes from the AI Gateway's
 * own response metadata when present, else from `ai.pricing`.
 */
import { defineConfig, on, usd } from "@void/sdk"
import { metered, modelPricing, voidOptions } from "@void/sdk/ai"
import { gateway, generateText, streamText } from "ai"

export const config = defineConfig({
  meters: {
    // every AI call, billed by total tokens
    ai_tokens: {
      filter: on("ai.generation"),
      aggregate: { sum: "total_tokens" },
    },
    // and counted per request for the quota entitlement
    ai_requests: {
      filter: on("ai.generation"),
      aggregate: "count",
    },
  },

  // first-class AI: models wrapped with `metered` inherit these defaults
  ai: {
    event: "ai.generation",
    // fallback rates (per 1M tokens) for when the gateway doesn't report
    // cost — e.g. a locally proxied or BYOK model. Gateway cost wins.
    // `modelPricing` autocompletes AI Gateway model ids.
    pricing: modelPricing({
      "openai/gpt-4o": { input: usd(2.5), output: usd(10) },
      "*": { input: usd(1), output: usd(3) },
    }),
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
        // cost-plus pricing: the `_cost` each call reports is marked up
        ai_tokens: { margin: "40%" },
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
// The metered model: one line — event, pricing, properties come from the
// config above, so call sites only ever say who the customer is.
// ---------------------------------------------------------------------------

export const assistant = metered(gateway("openai/gpt-4o"), { client: voidClient })

// ---------------------------------------------------------------------------
// Using it: attribution rides on providerOptions, nothing else changes.
// ---------------------------------------------------------------------------

export const reply = async (customer: string, question: string) => {
  const gate = await voidClient.entitlements(customer)
  if (!gate.allowed("ai_assistant") || !gate.allowed("ai_quota")) {
    throw new Error("AI assistant not available on this plan")
  }

  const { text } = await generateText({
    model: assistant,
    prompt: question,
    providerOptions: {
      void: voidOptions({ customer, properties: { feature: "assistant" }, }),
    },
  })
  // recorded: ai.generation { customer, model, input_tokens, output_tokens,
  //           total_tokens, duration_ms, feature } + _cost from the gateway
  return text
}

export const replyStreaming = (customer: string, question: string) =>
  streamText({
    model: assistant,
    prompt: question,
    providerOptions: { void: voidOptions({ customer }) },
    // recorded once the stream finishes, from the finish part's usage;
    // aborted streams never are
  })

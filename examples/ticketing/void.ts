/**
 * The helpdesk's `void.ts` — its customers' state of record, as one typed
 * config, with billing derived from it as a side effect.
 *
 * The whole story lives in this one file:
 *  - outcome pricing: a *resolved* ticket bills $1.50; a reopen within
 *    7 days unwinds exactly that ticket's charge
 *  - cost-plus AI: agent replies report their token cost, and the tokens
 *    meter is priced at a 70% gross margin over whatever the model costs
 *  - entitlements gate the product: the AI agent is a feature flag, replies
 *    have a live monthly quota
 *  - invariants police the business: bills cap at $200, runaway usage flips
 *    enforcement to "blocked", unprofitable customers raise alerts — and the
 *    margin floor is *proven* when this module loads
 *  - acme has a negotiated deal, held to the same invariants
 *
 * The app talks to the void *proxy*, not the parent server: entitlement and
 * enforcement checks are answered on this machine (instant, and they keep
 * working if the parent is down), while events are journaled locally and
 * forwarded upstream. Fully typed — meter/entitlement/event ids come from
 * the config below.
 */
import { defineConfig, on, usd } from "@void/sdk"
import { metered, modelPricing } from "@void/sdk/ai"
import { agentModel } from "./lib/agent"

export const config = defineConfig({
  meters: {
    // The AI agent as a meter: every call through `voidClient.ai.agent`
    // tracks an `ai.agent` event with token counts and its `_cost` attached,
    // and expands into agent.input_tokens / .cached_input_tokens /
    // .output_tokens meters automatically — the ai-sdk reports each class.
    agent: metered(agentModel, {
      // fallback per-1M-token rates; gateway-reported cost wins when present
      pricing: modelPricing({
        "openai/gpt-4o-mini": { input: usd(0.15), output: usd(0.6) },
        "*": { input: usd(3), output: usd(12) },
      }),
      // one console line per lifecycle step (call, finish, cost, track) —
      // pass a function for a structured sink, or drop this and use
      // VOID_AI_DEBUG=1 to toggle from the environment
      log: true,
    }),

    agent_replies: {
      filter: on("ai.agent"),
      aggregate: "count",
      unit: "scalar",
    },

    ticket_resolution: {
      correlate: "ticket_id",
      steps: [
        on("ticket.opened"),
        on("ticket.closed", { resolution: "solved" }),
      ],
      failOn: { on: on("ticket.reopened"), within: "7 days" },
    },
  },

  products: {
    support_pro: {
      name: "Support Pro",
      price: { every: "month", amount: usd(0) },

      entitlements: {
        ai_agent: true, // feature flag: can this workspace use the agent?
        seats: { limit: 3 },
        reply_quota: { meter: "agent_replies", limit: 200 }, // live usage cap
      },

      usage: {
        ticket_resolution: { perUnit: usd(1.5) }, // pay per resolved ticket
        // Cost-plus per reply: each ai.agent event's full `_cost`, marked up.
        // IMPORTANT: margin pricing must sit on exactly ONE meter matching
        // the event. The server attributes an event's whole `_cost` to every
        // matching meter, so margin-pricing agent.input_tokens,
        // .cached_input_tokens and .output_tokens together would bill the
        // same cost three times (3 × cost/(1-margin) = 6× cost at 50%).
        agent_replies: { margin: "50%" },
      },
    },
  },

  invariants: [
    { name: "AI stays profitable", assert: { margin: "agent_replies", gte: "40%" } },
    { name: "bill shock protection", assert: { spend: "customer", lte: usd(200) }, else: "cap" },
    { name: "runaway usage hard stop", assert: { spend: "customer", lte: usd(400) }, else: "block" },
    { name: "no unprofitable customers", assert: { margin: "customer", gte: "20%" }, else: "notify" },
  ],

  // acme negotiated resolutions at $1 and a bigger reply quota.
  overrides: {
    acme: {
      until: "2027-01-01",
      usage: { ticket_resolution: { perUnit: usd(1) } },
      entitlements: { reply_quota: { meter: "agent_replies", limit: 500 } },
    },
  },
})

export const PROXY_URL = process.env.VOID_PROXY_URL ?? "http://localhost:4010"

export const voidClient = config.connect({ endpoint: PROXY_URL })

export const proxyHealth = async (): Promise<{
  upstream: string
  backlog: number
} | null> => {
  try {
    const response = await fetch(`${PROXY_URL}/health`, { cache: "no-store" })
    return (await response.json()) as { upstream: string; backlog: number }
  } catch {
    return null
  }
}

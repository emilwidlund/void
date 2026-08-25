/**
 * The billing model for the support ticketing demo, as code.
 *
 * The whole monetization story lives in this one file:
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
 */
import { defineConfig, on, usd } from "@void/sdk"

export const billing = defineConfig({
  meters: {
    agent_replies: {
      filter: on("agent.reply"),
      aggregate: "count",
      unit: "scalar",
    },

    ai_tokens: {
      filter: on("agent.reply"),
      aggregate: { sum: "tokens" },
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
      price: { every: "month", amount: usd(49) },

      entitlements: {
        ai_agent: true, // feature flag: can this workspace use the agent?
        seats: { limit: 3 },
        reply_quota: { meter: "agent_replies", limit: 200 }, // live usage cap
      },

      usage: {
        ticket_resolution: { perUnit: usd(1.5) }, // pay per resolved ticket
        ai_tokens: { margin: "70%" }, // cost-plus over reported model spend
      },
    },
  },

  invariants: [
    { name: "AI stays profitable", assert: { margin: "ai_tokens", gte: "40%" } },
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

export type Billing = typeof billing

import { defineConfig, on, usd } from "@void/sdk"
import { metered } from "@void/sdk/ai"
import { agentModel } from "./lib/agent"


export const config = defineConfig({
  meters: {
    agent: metered(agentModel, {
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
        ticket_resolution: { perUnit: usd(1.5) },
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

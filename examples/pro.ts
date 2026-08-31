import { defineConfig, money, on, usd, usdCents } from "@void/sdk"

const billing = defineConfig({
  meters: {
    api_calls: {
      filter: on("api.request"),
      aggregate: "count",
      unit: "scalar",
    },

    compute_seconds: {
      filter: on("compute.done", { status: "success" }),
      aggregate: { sum: "duration_s" },
      unit: "minutes", // priced per minute below; the compiler converts
    },

    // Success-based billing as a correlated chain: one instance per
    // ticket_id, steps in order, completion bills one unit, a reopen within
    // 7 days unwinds exactly that ticket's charge.
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
    awesome: {
      name: "Wow",
      price: { every: "week", amount: money(20, "GBP", { minor: true }) },
      entitlements: {
        seats: { limit: 5 },
      },
    },

    pro: {
      name: "Pro Plan",
      price: { every: "month", amount: usd(29) },

      entitlements: {
        sso: true, // boolean feature grant
        seats: { limit: 5 }, // static limit
        api_quota: { meter: "api_calls", limit: 100_000 }, // live usage cap
      },

      // One `usage` table covers meters and outcomes — keys are checked
      // against the declarations above, so `api_callz` would not compile.
      usage: {
        api_calls: { perUnit: usdCents(10), included: 10_000 },
        compute_seconds: { margin: "60%" }, // cost-derived price
        ticket_resolution: { perUnit: usd(2) }, // outcome: pay per success
      },
    },
  },

  invariants: [
    // Meter-scoped assertions are proven when defineConfig runs — a config
    // (or a negotiated override) that breaks them throws.
    { name: "compute stays profitable", assert: { margin: "compute_seconds", gte: "40%" } },
    { name: "API price floor", assert: { price: "api_calls", gte: usdCents(5) }, else: "warn" },

    // Customer-scoped assertions are monitored live; `else` is the remedy.
    { name: "bill shock protection", assert: { spend: "customer", lte: usd(500) }, else: "cap" },
    { name: "runaway usage hard stop", assert: { spend: "customer", lte: usd(1_000) }, else: "block" },
    { name: "no unprofitable customers", assert: { margin: "customer", gte: "20%" }, else: "notify" },
  ],

  // Negotiated deals as config — held to the same invariants as list prices.
  overrides: {
    acme: {
      until: "2027-01-01",
      usage: {
        api_calls: { perUnit: usdCents(8), included: 50_000 },
      },
      entitlements: {
        seats: { limit: 20 },
      },
    },
  },
})

export default billing

// ---------------------------------------------------------------------------
// Using it: a fully typed client, bound to this config.
// ---------------------------------------------------------------------------

export const example = async () => {
  const client = billing.connect({ endpoint: "http://localhost:4000" })

  // Deploy is a no-op when the checksum is already active — safe in CI.
  await client.deploy()

  // Track usage with cost attached; field names map to the wire format.
  await client.track("compute.done", {
    customer: "acme",
    properties: { status: "success", duration_s: 12.5 },
    cost: usdCents(0.42),
  })

  // Outcome chains, correlated per ticket:
  await client.track("ticket.opened", { customer: "acme", properties: { ticket_id: "T-1" } })
  await client.track("ticket.closed", {
    customer: "acme",
    properties: { ticket_id: "T-1", resolution: "solved" },
  })

  // Entitlement ids are literal types: `allowed("acme", "ssso")` won't compile.
  if (await client.allowed("acme", "api_quota")) {
    // serve the request
  }

  const status = await client.entitlements("acme")
  if (status.enforcement === "blocked") {
    // a `spend(customer) ... else block` invariant tripped — stop serving
  }
}

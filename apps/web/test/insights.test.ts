import type { BillingIr } from "@void/compiler"
import { describe, expect, it } from "vitest"
import { overageCustomers, paceDelta, unpricedMeters } from "../lib/insights"
import { computeSpend } from "../lib/spend"
import type { UsageRow } from "../lib/types"

const ir: BillingIr = {
  version: 1,
  meters: [{ id: "api_calls", filter: null, aggregation: { type: "count" }, unit: null, reverse: null }],
  outcomes: [],
  products: [
    {
      id: "pro",
      name: "Pro",
      prices: [
        {
          type: "metered",
          meter: "api_calls",
          per_unit: { currency: "USD", amount: "10" },
          included_units: 100,
          per: null,
          unit_factor: 1
        }
      ],
      entitlements: []
    }
  ],
  invariants: [],
  overrides: []
}

const row = (customer: string, value: number): UsageRow => ({
  meter: "api_calls",
  customer,
  aggregation: "count",
  value
})

describe("insights", () => {
  it("finds customers billing overage", () => {
    const spend = computeSpend(
      [row("over", 150), row("under", 50)],
      ir,
      "2026-08-01T00:00:00.000Z",
      new Date("2026-08-11T00:00:00.000Z")
    )
    expect(overageCustomers(spend)).toEqual(["over"])
  })

  it("finds unpriced meters", () => {
    const usage = [row("acme", 10), { ...row("acme", 5), meter: "logins" }]
    expect(unpricedMeters(usage, ir)).toEqual(["logins"])
  })

  it("doesn't flag meters whose event is priced through a sibling meter", () => {
    const eventFilter = {
      type: "comparison" as const,
      property: "event.name",
      op: "eq" as const,
      value: "ai.agent"
    }
    const aiIr: BillingIr = {
      ...ir,
      meters: [
        // priced (margin) meter and analytics meters over the same event
        { id: "agent_replies", filter: eventFilter, aggregation: { type: "count" }, unit: null, reverse: null },
        {
          id: "agent.input_tokens",
          filter: eventFilter,
          aggregation: { type: "sum", property: "event.input_tokens" },
          unit: null,
          reverse: null
        },
        // a genuinely dead meter on a different event
        { id: "logins", filter: { ...eventFilter, value: "user.login" }, aggregation: { type: "count" }, unit: null, reverse: null }
      ],
      products: [
        {
          id: "pro",
          name: "Pro",
          prices: [{ type: "metered_margin", meter: "agent_replies", margin: 0.5 }],
          entitlements: []
        }
      ]
    }
    const usage = [
      { ...row("acme", 3), meter: "agent_replies" },
      { ...row("acme", 500), meter: "agent.input_tokens" },
      { ...row("acme", 2), meter: "logins" }
    ]
    expect(unpricedMeters(usage, aiIr)).toEqual(["logins"])
  })

  it("computes pace change from the recent window", () => {
    // steady 1 unit/minute for 30min, then 3 units/minute: recent pace up
    const points = Array.from({ length: 40 }, (_, i) => ({
      t: i * 60_000,
      accruedMinor: i < 30 ? i : 30 + (i - 30) * 3,
      costMinor: 0
    }))
    const delta = paceDelta(points)
    expect(delta).not.toBeNull()
    expect(delta!).toBeGreaterThan(0.2)
  })

  it("returns null pace with too little history", () => {
    expect(paceDelta([{ t: 0, accruedMinor: 0, costMinor: 0 }])).toBeNull()
  })
})

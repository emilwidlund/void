import type { BillingIr } from "@void/compiler"
import { describe, expect, it } from "vitest"
import { overageCustomers, paceDelta, unpricedMeters } from "../lib/insights"
import { computeSpend } from "../lib/spend"
import type { UsageRow } from "../lib/types"

const ir: BillingIr = {
  version: 1,
  meters: [{ id: "api_calls", filter: null, aggregation: { type: "count" }, unit: null }],
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
  invariants: []
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

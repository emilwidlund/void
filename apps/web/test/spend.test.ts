import type { BillingIr } from "@void/compiler"
import { describe, expect, it } from "vitest"
import { computeSpend } from "../lib/spend"
import type { UsageRow } from "../lib/types"

const ir: BillingIr = {
  version: 1,
  meters: [
    { id: "api_calls", filter: null, aggregation: { type: "count" } },
    {
      id: "compute_seconds",
      filter: null,
      aggregation: { type: "sum", property: "event.duration_s" }
    }
  ],
  products: [
    {
      id: "pro",
      name: "Pro Plan",
      prices: [
        { type: "recurring", interval: "month", amount: { currency: "USD", amount: "2900" } },
        {
          type: "metered",
          meter: "api_calls",
          per_unit: { currency: "USD", amount: "10" },
          included_units: 1000
        },
        {
          type: "metered",
          meter: "compute_seconds",
          per_unit: { currency: "USD", amount: "0.1" },
          included_units: 0
        }
      ]
    }
  ]
}

const row = (meter: string, customer: string, value: number): UsageRow => ({
  meter,
  customer,
  aggregation: meter === "api_calls" ? "count" : "sum",
  value
})

const deployedAt = "2026-08-01T00:00:00.000Z"
const tenDaysLater = new Date("2026-08-11T00:00:00.000Z")

describe("computeSpend", () => {
  it("attributes products, base fees and accrued/projected metered spend", () => {
    const overview = computeSpend(
      [row("api_calls", "acme", 1500), row("compute_seconds", "acme", 3000)],
      ir,
      deployedAt,
      tenDaysLater
    )
    expect(overview.customers).toHaveLength(1)
    const acme = overview.customers[0]!
    expect(acme.products).toEqual(["Pro Plan"])
    expect(acme.baseMinor).toBe(2900)
    // accrued: (1500-1000)*10 + 3000*0.1 = 5000 + 300 = 5300 cents
    expect(acme.accruedMinor).toBeCloseTo(5300)
    // projected: api 4500 units -> 3500 billable * 10 = 35000; compute 9000 * 0.1 = 900; + base
    expect(acme.projectedMinor).toBeCloseTo(2900 + 35000 + 900)
  })

  it("charges only the base while usage stays inside the allowance", () => {
    const overview = computeSpend([row("api_calls", "acme", 100)], ir, deployedAt, tenDaysLater)
    const acme = overview.customers[0]!
    expect(acme.accruedMinor).toBe(0)
    expect(acme.projectedMinor).toBe(2900)
    expect(acme.lines[0]!.includedUsed).toBeCloseTo(0.1)
  })

  it("does not attribute base fees without usage on the product's meters", () => {
    const overview = computeSpend([], ir, deployedAt, tenDaysLater)
    expect(overview.customers).toEqual([])
    expect(overview.totals.projectedMinor).toBe(0)
  })

  it("normalizes non-monthly recurring intervals to a 30-day equivalent", () => {
    const yearly: BillingIr = {
      ...ir,
      products: [
        {
          id: "pro",
          name: "Pro",
          prices: [
            {
              type: "recurring",
              interval: "year",
              amount: { currency: "USD", amount: "36500" }
            },
            {
              type: "metered",
              meter: "api_calls",
              per_unit: { currency: "USD", amount: "10" },
              included_units: 0
            }
          ]
        }
      ]
    }
    const overview = computeSpend([row("api_calls", "acme", 0)], yearly, deployedAt, tenDaysLater)
    expect(overview.customers[0]!.baseMinor).toBeCloseTo(36500 * (30 / 365))
  })

  it("ranks customers by projected spend and totals across them", () => {
    const overview = computeSpend(
      [row("api_calls", "small", 1100), row("api_calls", "big", 5000)],
      ir,
      deployedAt,
      tenDaysLater
    )
    expect(overview.customers.map((c) => c.customer)).toEqual(["big", "small"])
    expect(overview.totals.accruedMinor).toBeCloseTo((5000 - 1000) * 10 + (1100 - 1000) * 10)
  })

  it("ignores usage on meters that no product prices", () => {
    const overview = computeSpend(
      [row("api_calls", "acme", 2000), { meter: "logins", customer: "acme", aggregation: "unique", value: 4 }],
      ir,
      deployedAt,
      tenDaysLater
    )
    expect(overview.customers[0]!.lines).toHaveLength(1)
  })
})

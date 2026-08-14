import type { BillingIr } from "@void/compiler"
import { describe, expect, it } from "vitest"
import { computeSpend } from "../lib/spend"
import type { UsageRow } from "../lib/types"

const ir: BillingIr = {
  version: 1,
  meters: [
    { id: "api_calls", filter: null, aggregation: { type: "count" }, unit: null },
    {
      id: "compute_seconds",
      filter: null,
      aggregation: { type: "sum", property: "event.duration_s" },
      unit: null
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
          included_units: 1000,
          per: null,
          unit_factor: 1
        },
        {
          type: "metered",
          meter: "compute_seconds",
          per_unit: { currency: "USD", amount: "0.1" },
          included_units: 0,
          per: null,
          unit_factor: 1
        }
      ],
      entitlements: []
    }
  ],
  invariants: []
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
              included_units: 0,
              per: null,
              unit_factor: 1
            }
          ],
          entitlements: []
        }
      ],
      invariants: []
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

  it("computes cost and gross margin from reported event costs", () => {
    const overview = computeSpend(
      [row("api_calls", "acme", 2000)],
      ir,
      deployedAt,
      tenDaysLater,
      [
        { customer: "acme", event: "api.request", currency: "USD", cost_minor: 500 },
        { customer: "acme", event: "compute.done", currency: "USD", cost_minor: 100 }
      ]
    )
    const acme = overview.customers[0]!
    expect(acme.costMinor).toBe(600)
    // 10 of 30 days elapsed -> run rate 3x
    expect(acme.projectedCostMinor).toBeCloseTo(1800)
    expect(acme.marginPct).toBeCloseTo((acme.projectedMinor - 1800) / acme.projectedMinor)
    expect(acme.costsByEvent).toEqual([
      { event: "api.request", currency: "USD", costMinor: 500 },
      { event: "compute.done", currency: "USD", costMinor: 100 }
    ])
    expect(overview.totals.costMinor).toBe(600)
    expect(overview.totals.marginPct).not.toBeNull()
  })

  it("includes cost-only customers as pure loss", () => {
    const overview = computeSpend([], ir, deployedAt, tenDaysLater, [
      { customer: "freeloader", event: "compute.done", currency: "USD", cost_minor: 250 }
    ])
    const freeloader = overview.customers[0]!
    expect(freeloader.costMinor).toBe(250)
    expect(freeloader.projectedMinor).toBe(0)
    expect(freeloader.marginPct).toBeNull()
    expect(freeloader.products).toEqual([])
  })

  it("derives margin-priced charges from attributed meter costs", () => {
    const marginIr: BillingIr = {
      version: 1,
      meters: [
        {
          id: "compute_seconds",
          filter: null,
          aggregation: { type: "sum", property: "event.duration_s" },
          unit: null
        }
      ],
      products: [
        {
          id: "gpu",
          name: "GPU",
          prices: [{ type: "metered_margin", meter: "compute_seconds", margin: 0.6 }],
          entitlements: []
        }
      ],
      invariants: []
    }
    const overview = computeSpend(
      [{ meter: "compute_seconds", customer: "acme", aggregation: "sum", value: 100 }],
      marginIr,
      deployedAt,
      tenDaysLater,
      [{ customer: "acme", event: "compute.done", currency: "USD", cost_minor: 400 }],
      [{ meter: "compute_seconds", customer: "acme", currency: "USD", cost_minor: 400 }]
    )
    const acme = overview.customers[0]!
    const line = acme.lines[0]!
    // charge = cost / (1 - 0.6) = 400 / 0.4 = 1000 minor units
    expect(line.accruedMinor).toBeCloseTo(1000)
    expect(line.marginTarget).toBe(0.6)
    expect(line.perUnitMinor).toBeCloseTo(10)
    expect(acme.accruedMinor).toBeCloseTo(1000)
    // run rate 3x, margin holds: (3000 - 1200) / 3000 = 0.6
    expect(acme.projectedMinor).toBeCloseTo(3000)
    expect(acme.marginPct).toBeCloseTo(0.6)
  })

  it("converts meter units to priced units before charging", () => {
    const msIr: BillingIr = {
      version: 1,
      meters: [
        {
          id: "compute",
          filter: null,
          aggregation: { type: "sum", property: "event.duration_ms" },
          unit: "millisecond"
        }
      ],
      products: [
        {
          id: "pro",
          name: "Pro",
          prices: [
            {
              type: "metered",
              meter: "compute",
              per_unit: { currency: "USD", amount: "10" },
              included_units: 60,
              per: "second",
              unit_factor: 1000
            }
          ],
          entitlements: []
        }
      ],
      invariants: []
    }
    const overview = computeSpend(
      [{ meter: "compute", customer: "acme", aggregation: "sum", value: 120_000 }],
      msIr,
      deployedAt,
      tenDaysLater
    )
    const line = overview.customers[0]!.lines[0]!
    // 120,000 ms = 120 priced seconds; 60 included -> 60 billable * 10 = 600
    expect(line.units).toBeCloseTo(120)
    expect(line.includedUsed).toBeCloseTo(2)
    expect(line.accruedMinor).toBeCloseTo(600)
  })

  it("clamps bills at an `else cap` spend ceiling", () => {
    const cappedIr: BillingIr = {
      ...ir,
      invariants: [
        {
          name: "bill shock",
          metric: "spend",
          meter: null,
          op: "lte",
          threshold: 5000,
          currency: "USD",
          behavior: "cap"
        }
      ]
    }
    const overview = computeSpend(
      // uncapped: base 2900 + (2000-1000)*10 = 12900 minor
      [row("api_calls", "acme", 2000)],
      cappedIr,
      deployedAt,
      tenDaysLater
    )
    const acme = overview.customers[0]!
    expect(acme.uncappedSpendMinor).toBeCloseTo(12900)
    expect(acme.capMinor).toBe(5000)
    // base bills first, usage absorbs the clamp: billed usage = 5000 - 2900
    expect(acme.accruedMinor).toBeCloseTo(2100)
    expect(acme.cappedMinor).toBeCloseTo(7900)
    expect(acme.projectedMinor).toBe(5000)
    expect(overview.totals.cappedMinor).toBeCloseTo(7900)
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

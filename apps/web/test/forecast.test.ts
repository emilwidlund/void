import type { BillingIr } from "@void/compiler"
import { describe, expect, it } from "vitest"
import { forecastUsage } from "../lib/forecast"

const ir: BillingIr = {
  version: 1,
  meters: [
    { id: "api_calls", filter: null, aggregation: { type: "count" } },
    { id: "compute_seconds", filter: null, aggregation: { type: "sum", property: "event.duration_s" } }
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

const deployedAt = "2026-08-01T00:00:00.000Z"
const tenDaysLater = new Date("2026-08-11T00:00:00.000Z")

describe("forecastUsage", () => {
  it("projects usage at the observed run rate over 30 days", () => {
    const forecasts = forecastUsage(
      [{ meter: "api_calls", customer: "acme", aggregation: "count", value: 500 }],
      ir,
      deployedAt,
      tenDaysLater
    )
    expect(forecasts).toHaveLength(1)
    const f = forecasts[0]!
    // 500 units in 10 days -> 1500 over 30 days; 500 over the included 1000
    expect(f.projectedUnits).toBeCloseTo(1500)
    expect(f.includedUnits).toBe(1000)
    // 500 billable units at 10 cents -> 5000 cents
    expect(f.projectedCostMinor).toBeCloseTo(5000)
  })

  it("charges nothing while projected usage stays within the allowance", () => {
    const forecasts = forecastUsage(
      [{ meter: "api_calls", customer: "acme", aggregation: "count", value: 100 }],
      ir,
      deployedAt,
      tenDaysLater
    )
    expect(forecasts[0]!.projectedUnits).toBeCloseTo(300)
    expect(forecasts[0]!.projectedCostMinor).toBe(0)
  })

  it("handles fractional-cent per-unit prices", () => {
    const forecasts = forecastUsage(
      [{ meter: "compute_seconds", customer: "acme", aggregation: "sum", value: 3000 }],
      ir,
      deployedAt,
      tenDaysLater
    )
    // 9000 projected seconds at 0.1 cents -> 900 cents
    expect(forecasts[0]!.projectedCostMinor).toBeCloseTo(900)
  })

  it("sorts by projected cost and covers each customer separately", () => {
    const forecasts = forecastUsage(
      [
        { meter: "api_calls", customer: "small", aggregation: "count", value: 400 },
        { meter: "api_calls", customer: "big", aggregation: "count", value: 5000 }
      ],
      ir,
      deployedAt,
      tenDaysLater
    )
    expect(forecasts.map((f) => f.customer)).toEqual(["big", "small"])
  })

  it("clamps very fresh deploys to a one-hour minimum window", () => {
    const justDeployed = new Date("2026-08-01T00:00:30.000Z")
    const forecasts = forecastUsage(
      [{ meter: "api_calls", customer: "acme", aggregation: "count", value: 10 }],
      ir,
      deployedAt,
      justDeployed
    )
    // 10 units in ≥1h floor -> at most 10 * 24 * 30 = 7200 projected
    expect(forecasts[0]!.projectedUnits).toBeLessThanOrEqual(7200)
  })
})

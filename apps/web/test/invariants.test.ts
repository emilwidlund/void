import type { BillingIr, IrInvariant } from "@void/compiler"
import { describe, expect, it } from "vitest"
import { evaluateInvariants, formatInvariant } from "../lib/invariants"
import { computeSpend } from "../lib/spend"

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
          included_units: 0,
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

const spendCap: IrInvariant = {
  name: "bill shock",
  metric: "spend",
  meter: null,
  op: "lte",
  threshold: 5000,
  currency: "USD",
  behavior: null
}

const marginFloor: IrInvariant = {
  name: "profitable customers",
  metric: "margin",
  meter: null,
  op: "gte",
  threshold: 0.2,
  currency: null,
  behavior: null
}

const deployedAt = "2026-08-01T00:00:00.000Z"
const tenDaysLater = new Date("2026-08-11T00:00:00.000Z")

const usage = (customer: string, value: number) => ({
  meter: "api_calls",
  customer,
  aggregation: "count",
  value
})

describe("evaluateInvariants", () => {
  it("flags customers whose spend breaks a cap", () => {
    const spend = computeSpend(
      [usage("whale", 1000), usage("minnow", 10)],
      ir,
      deployedAt,
      tenDaysLater
    )
    const violations = evaluateInvariants([spendCap], spend)
    expect(violations).toHaveLength(1)
    expect(violations[0]!.name).toBe("bill shock")
    expect(violations[0]!.text).toContain("whale")
  })

  it("flags customers below a margin floor, skipping cost-free ones", () => {
    const spend = computeSpend(
      [usage("lossy", 100), usage("costless", 100)],
      ir,
      deployedAt,
      tenDaysLater,
      // lossy: revenue 1000 minor, cost 5000 minor -> deeply negative margin
      [{ customer: "lossy", event: "api.request", currency: "USD", cost_minor: 5000 }]
    )
    const violations = evaluateInvariants([marginFloor], spend)
    expect(violations).toHaveLength(1)
    expect(violations[0]!.text).toContain("lossy")
  })

  it("skips compile-checked meter-scoped invariants", () => {
    const spend = computeSpend([usage("acme", 1000)], ir, deployedAt, tenDaysLater)
    const staticInvariant: IrInvariant = {
      name: "floor",
      metric: "price",
      meter: "api_calls",
      op: "gte",
      threshold: 5,
      currency: "USD",
      behavior: null
    }
    expect(evaluateInvariants([staticInvariant], spend)).toEqual([])
  })
})

describe("evaluateInvariants with behaviors", () => {
  it("reports a capped bill as a remedied violation, judged on uncapped spend", () => {
    const withCap: BillingIr = {
      ...ir,
      invariants: [{ ...spendCap, behavior: "cap" }]
    }
    const spend = computeSpend([usage("whale", 1000)], withCap, deployedAt, tenDaysLater)
    // billed spend is clamped to the cap, but the violation still surfaces
    expect(spend.customers[0]!.baseMinor + spend.customers[0]!.accruedMinor).toBe(5000)
    const violations = evaluateInvariants(withCap.invariants, spend)
    expect(violations).toHaveLength(1)
    expect(violations[0]!.text).toContain("remedied: bill capped")
  })

  it("marks block behaviors as enforcement", () => {
    const spend = computeSpend([usage("whale", 1000)], ir, deployedAt, tenDaysLater)
    const violations = evaluateInvariants([{ ...spendCap, behavior: "block" }], spend)
    expect(violations[0]!.text).toContain("enforcement: blocked")
  })
})

describe("formatInvariant", () => {
  it("renders DSL-ish text", () => {
    expect(formatInvariant(spendCap)).toBe("spend(customer) ≤ $50.00")
    expect(formatInvariant({ ...spendCap, behavior: "cap" })).toBe(
      "spend(customer) ≤ $50.00 else cap"
    )
    expect(formatInvariant(marginFloor)).toBe("margin(customer) ≥ 20%")
  })
})

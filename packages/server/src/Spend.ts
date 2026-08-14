import type { BillingIr, IrInvariant } from "@void/compiler"
import type { MeterCostRow, UsageRow } from "./UsageEngine.js"

/**
 * Server-side accrued spend for one customer, mirroring the dashboard's
 * model (accrued only, no projections): recurring fees normalized to a
 * 30-day period for attributed products, per-unit charges beyond included
 * allowances (after unit conversion), and margin-priced charges derived
 * from attributed meter costs. Used to evaluate customer-scoped invariants
 * for enforcement.
 */

const INTERVAL_TO_30D: Readonly<Record<string, number>> = {
  month: 1,
  year: 30 / 365,
  week: 30 / 7,
  day: 30
}

export const accruedSpendMinor = (
  customer: string,
  ir: BillingIr,
  usage: ReadonlyArray<UsageRow>,
  meterCosts: ReadonlyArray<MeterCostRow>
): number => {
  const rows = usage.filter((row) => row.customer === customer)
  let base = 0
  let metered = 0

  for (const product of ir.products) {
    let attributed = false
    for (const price of product.prices) {
      if (price.type === "metered") {
        const row = rows.find((r) => r.meter === price.meter)
        if (row === undefined) continue
        attributed = true
        const pricedUnits = row.value / price.unit_factor
        metered +=
          Math.max(0, pricedUnits - price.included_units) * Number(price.per_unit.amount)
      } else if (price.type === "metered_margin") {
        const cost = meterCosts
          .filter((mc) => mc.meter === price.meter && mc.customer === customer)
          .reduce((sum, mc) => sum + mc.cost_minor, 0)
        const row = rows.find((r) => r.meter === price.meter)
        if (row === undefined && cost === 0) continue
        attributed = true
        metered += cost / (1 - price.margin)
      }
    }
    if (attributed) {
      for (const price of product.prices) {
        if (price.type !== "recurring") continue
        base += Number(price.amount.amount) * (INTERVAL_TO_30D[price.interval] ?? 1)
      }
    }
  }

  return base + metered
}

const compare = (left: number, op: IrInvariant["op"], right: number): boolean => {
  switch (op) {
    case "eq":
      return left === right
    case "ne":
      return left !== right
    case "gt":
      return left > right
    case "gte":
      return left >= right
    case "lt":
      return left < right
    case "lte":
      return left <= right
  }
}

export interface InvariantViolation {
  readonly invariant: string
  readonly behavior: IrInvariant["behavior"]
}

/**
 * Evaluates customer-scoped `spend` invariants against accrued spend.
 * (`margin(customer)` invariants are evaluated on the dashboard, which owns
 * the projection model.) A `cap` behavior means spend is clamped at the
 * threshold, so the uncapped figure is what the condition is tested against.
 */
export const violatedSpendInvariants = (
  customer: string,
  ir: BillingIr,
  usage: ReadonlyArray<UsageRow>,
  meterCosts: ReadonlyArray<MeterCostRow>
): ReadonlyArray<InvariantViolation> => {
  const relevant = ir.invariants.filter(
    (invariant) => invariant.metric === "spend" && invariant.meter === null
  )
  if (relevant.length === 0) return []
  const spend = accruedSpendMinor(customer, ir, usage, meterCosts)
  return relevant
    .filter((invariant) => !compare(spend, invariant.op, invariant.threshold))
    .map((invariant) => ({ invariant: invariant.name, behavior: invariant.behavior }))
}

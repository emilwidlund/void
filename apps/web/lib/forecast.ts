import type { BillingIr } from "@void/compiler"
import type { UsageRow } from "./types"

export const PERIOD_DAYS = 30
const MS_PER_DAY = 86_400_000
/** Below one hour of data the run rate is too noisy to extrapolate from. */
const MIN_ELAPSED_DAYS = 1 / 24

export interface MeterForecast {
  readonly product: string
  readonly productName: string
  readonly meter: string
  readonly customer: string
  readonly currentUnits: number
  readonly projectedUnits: number
  readonly includedUnits: number
  readonly currency: string
  /** per-unit price in minor units (may be fractional, e.g. 0.1 cents) */
  readonly perUnitMinor: number
  /** projected end-of-period cost in minor units, after the included allowance */
  readonly projectedCostMinor: number
}

/**
 * Naive run-rate forecast: assumes usage since the config was deployed
 * continues at the same velocity for a 30-day period, then prices the
 * projected overage (units beyond the included allowance) per metered price.
 */
export const forecastUsage = (
  usage: ReadonlyArray<UsageRow>,
  ir: BillingIr,
  deployedAt: string,
  now: Date
): ReadonlyArray<MeterForecast> => {
  const elapsedDays = Math.max(
    (now.getTime() - new Date(deployedAt).getTime()) / MS_PER_DAY,
    MIN_ELAPSED_DAYS
  )

  const forecasts: Array<MeterForecast> = []
  for (const product of ir.products) {
    for (const price of product.prices) {
      if (price.type !== "metered") continue
      for (const row of usage) {
        if (row.meter !== price.meter) continue
        const projectedUnits = row.value * (PERIOD_DAYS / elapsedDays)
        const billableUnits = Math.max(0, projectedUnits - price.included_units)
        const perUnitMinor = Number(price.per_unit.amount)
        forecasts.push({
          product: product.id,
          productName: product.name,
          meter: price.meter,
          customer: row.customer,
          currentUnits: row.value,
          projectedUnits,
          includedUnits: price.included_units,
          currency: price.per_unit.currency,
          perUnitMinor,
          projectedCostMinor: billableUnits * perUnitMinor
        })
      }
    }
  }
  return forecasts.sort(
    (a, b) =>
      b.projectedCostMinor - a.projectedCostMinor ||
      a.meter.localeCompare(b.meter) ||
      a.customer.localeCompare(b.customer)
  )
}

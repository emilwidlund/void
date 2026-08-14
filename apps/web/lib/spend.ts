import type { BillingIr } from "@void/compiler"
import type { UsageRow } from "./types"

export const PERIOD_DAYS = 30
const MS_PER_DAY = 86_400_000
/** Below one hour of data the run rate is too noisy to extrapolate from. */
const MIN_ELAPSED_DAYS = 1 / 24

/** Converts a recurring interval to its 30-day-equivalent multiplier. */
const INTERVAL_TO_30D: Readonly<Record<string, number>> = {
  month: 1,
  year: 30 / 365,
  week: 30 / 7,
  day: 30
}

export interface MeterSpendLine {
  readonly product: string
  readonly productName: string
  readonly meter: string
  readonly aggregation: string
  readonly units: number
  readonly includedUnits: number
  /** fraction of the included allowance consumed (may exceed 1); null when nothing is included */
  readonly includedUsed: number | null
  readonly perUnitMinor: number
  /** spend accrued so far on units beyond the allowance, in minor units */
  readonly accruedMinor: number
  readonly projectedUnits: number
  readonly projectedMinor: number
}

export interface CustomerSpend {
  readonly customer: string
  /** product names attributed to this customer (usage on one of its meters) */
  readonly products: ReadonlyArray<string>
  /** recurring base fees (30-day equivalent), in minor units */
  readonly baseMinor: number
  /** metered spend accrued so far, in minor units */
  readonly accruedMinor: number
  /** base + projected metered spend over the next PERIOD_DAYS, in minor units */
  readonly projectedMinor: number
  readonly currency: string
  readonly lines: ReadonlyArray<MeterSpendLine>
}

export interface SpendOverview {
  readonly customers: ReadonlyArray<CustomerSpend>
  readonly totals: {
    readonly baseMinor: number
    readonly accruedMinor: number
    readonly projectedMinor: number
    readonly currency: string
  }
  readonly elapsedDays: number
}

/**
 * Customer spend model. Assumptions, given the config has no subscription
 * data yet: a customer is attributed to a product when they have usage on one
 * of its metered meters, which then contributes that product's recurring fees
 * as their base. Metered spend prices usage beyond each `included` allowance;
 * projections extrapolate the run rate observed since the config was deployed.
 */
export const computeSpend = (
  usage: ReadonlyArray<UsageRow>,
  ir: BillingIr,
  deployedAt: string,
  now: Date
): SpendOverview => {
  const elapsedDays = Math.max(
    (now.getTime() - new Date(deployedAt).getTime()) / MS_PER_DAY,
    MIN_ELAPSED_DAYS
  )
  const runRate = PERIOD_DAYS / elapsedDays

  const byCustomer = new Map<string, Array<UsageRow>>()
  for (const row of usage) {
    const rows = byCustomer.get(row.customer) ?? []
    rows.push(row)
    byCustomer.set(row.customer, rows)
  }

  let currency = "USD"
  const customers: Array<CustomerSpend> = []

  for (const [customer, rows] of byCustomer) {
    const lines: Array<MeterSpendLine> = []
    const attributed = new Map<string, (typeof ir.products)[number]>()

    for (const product of ir.products) {
      for (const price of product.prices) {
        if (price.type !== "metered") continue
        const row = rows.find((r) => r.meter === price.meter)
        if (row === undefined) continue
        attributed.set(product.id, product)
        currency = price.per_unit.currency
        const perUnitMinor = Number(price.per_unit.amount)
        const projectedUnits = row.value * runRate
        lines.push({
          product: product.id,
          productName: product.name,
          meter: price.meter,
          aggregation: row.aggregation,
          units: row.value,
          includedUnits: price.included_units,
          includedUsed: price.included_units > 0 ? row.value / price.included_units : null,
          perUnitMinor,
          accruedMinor: Math.max(0, row.value - price.included_units) * perUnitMinor,
          projectedUnits,
          projectedMinor: Math.max(0, projectedUnits - price.included_units) * perUnitMinor
        })
      }
    }

    let baseMinor = 0
    for (const product of attributed.values()) {
      for (const price of product.prices) {
        if (price.type !== "recurring") continue
        currency = price.amount.currency
        baseMinor += Number(price.amount.amount) * (INTERVAL_TO_30D[price.interval] ?? 1)
      }
    }

    const accruedMinor = lines.reduce((sum, line) => sum + line.accruedMinor, 0)
    const projectedMetered = lines.reduce((sum, line) => sum + line.projectedMinor, 0)

    customers.push({
      customer,
      products: [...attributed.values()].map((product) => product.name),
      baseMinor,
      accruedMinor,
      projectedMinor: baseMinor + projectedMetered,
      currency,
      lines: lines.sort((a, b) => b.projectedMinor - a.projectedMinor)
    })
  }

  customers.sort(
    (a, b) => b.projectedMinor - a.projectedMinor || a.customer.localeCompare(b.customer)
  )

  return {
    customers,
    totals: {
      baseMinor: customers.reduce((sum, c) => sum + c.baseMinor, 0),
      accruedMinor: customers.reduce((sum, c) => sum + c.accruedMinor, 0),
      projectedMinor: customers.reduce((sum, c) => sum + c.projectedMinor, 0),
      currency
    },
    elapsedDays
  }
}

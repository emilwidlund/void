import type { BillingIr, IrOverride, IrPrice } from "@void/compiler"
import type { CostRow, MeterCostRow, UsageRow } from "./types"

/** The customer's override, if one exists and hasn't expired. */
export const activeOverride = (
  ir: BillingIr,
  customer: string,
  now: Date
): IrOverride | undefined =>
  ir.overrides.find(
    (override) =>
      override.customer === customer &&
      (override.until === null || now.getTime() < Date.parse(override.until))
  )

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
  /** revenue accrued so far on units beyond the allowance, in minor units */
  readonly accruedMinor: number
  /** reported `_cost` attributed to this meter so far, in minor units */
  readonly costMinor: number
  readonly projectedUnits: number
  readonly projectedMinor: number
  /** target gross margin for cost-derived (`margin`) pricing, else null */
  readonly marginTarget: number | null
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
  /** base + metered accrued before any `else cap` clamp, in minor units */
  readonly uncappedSpendMinor: number
  /** the lowest applicable `else cap` spend ceiling, in minor units, or null */
  readonly capMinor: number | null
  /** spend forgone to the cap so far this period, in minor units */
  readonly cappedMinor: number
  /** reported `_cost` accrued so far, in minor units */
  readonly costMinor: number
  /** cost run rate extrapolated over PERIOD_DAYS, in minor units */
  readonly projectedCostMinor: number
  /**
   * Projected gross margin: (projected revenue − projected cost) / projected
   * revenue. Null when there is no projected revenue to divide by.
   */
  readonly marginPct: number | null
  /** cost accrued per event name and currency, largest first, in minor units */
  readonly costsByEvent: ReadonlyArray<{
    readonly event: string
    readonly currency: string
    readonly costMinor: number
  }>
  readonly currency: string
  readonly lines: ReadonlyArray<MeterSpendLine>
}

export interface SpendOverview {
  readonly customers: ReadonlyArray<CustomerSpend>
  readonly totals: {
    readonly baseMinor: number
    readonly accruedMinor: number
    readonly projectedMinor: number
    readonly costMinor: number
    readonly projectedCostMinor: number
    readonly marginPct: number | null
    /** total spend forgone to `else cap` ceilings this period, in minor units */
    readonly cappedMinor: number
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
  now: Date,
  costs: ReadonlyArray<CostRow> = [],
  meterCosts: ReadonlyArray<MeterCostRow> = []
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
  // Customers that only reported costs still show up — they're pure loss.
  for (const row of costs) {
    if (!byCustomer.has(row.customer)) byCustomer.set(row.customer, [])
  }

  const costsFor = (customer: string) =>
    costs
      .filter((row) => row.customer === customer)
      .map((row) => ({ event: row.event, currency: row.currency, costMinor: row.cost_minor }))
      .sort((a, b) => b.costMinor - a.costMinor)

  // The lowest `spend(customer) ... else cap` ceiling clamps period bills.
  const capMinor = ir.invariants
    .filter((inv) => inv.metric === "spend" && inv.meter === null && inv.behavior === "cap")
    .reduce<number | null>(
      (lowest, inv) => (lowest === null ? inv.threshold : Math.min(lowest, inv.threshold)),
      null
    )

  let currency = "USD"
  const customers: Array<CustomerSpend> = []

  for (const [customer, rows] of byCustomer) {
    const lines: Array<MeterSpendLine> = []
    const attributed = new Map<string, (typeof ir.products)[number]>()

    // Negotiated deal: override prices shadow the product's for this customer.
    const override = activeOverride(ir, customer, now)
    const overrideByMeter = new Map<string, IrPrice>(
      (override?.prices ?? []).flatMap((price) =>
        price.type === "recurring" ? [] : [[price.meter, price] as const]
      )
    )
    const overrideRecurring = (override?.prices ?? []).filter(
      (price) => price.type === "recurring"
    )

    const meterCostFor = (meter: string) =>
      meterCosts
        .filter((mc) => mc.meter === meter && mc.customer === customer)
        .reduce((sum, mc) => sum + mc.cost_minor, 0)

    for (const product of ir.products) {
      for (const listed of product.prices) {
        if (listed.type === "recurring") continue
        const price = overrideByMeter.get(listed.meter) ?? listed
        if (price.type === "recurring") continue
        const row = rows.find((r) => r.meter === price.meter)
        if (price.type === "metered") {
          if (row === undefined) continue
          attributed.set(product.id, product)
          currency = price.per_unit.currency
          const perUnitMinor = Number(price.per_unit.amount)
          // Usage in meter units -> priced units ("per second" on a ms meter)
          const pricedUnits = row.value / price.unit_factor
          const projectedUnits = pricedUnits * runRate
          lines.push({
            product: product.id,
            productName: product.name,
            meter: price.meter,
            aggregation: row.aggregation,
            units: pricedUnits,
            includedUnits: price.included_units,
            includedUsed:
              price.included_units > 0 ? pricedUnits / price.included_units : null,
            perUnitMinor,
            accruedMinor: Math.max(0, pricedUnits - price.included_units) * perUnitMinor,
            costMinor: meterCostFor(price.meter),
            projectedUnits,
            projectedMinor: Math.max(0, projectedUnits - price.included_units) * perUnitMinor,
            marginTarget: null
          })
          continue
        }
        // Cost-derived pricing: charge = attributed cost / (1 - margin), so
        // the configured gross margin holds whatever the units cost.
        const attributedCost = meterCostFor(price.meter)
        if (row === undefined && attributedCost === 0) continue
        attributed.set(product.id, product)
        const accrued = attributedCost / (1 - price.margin)
        const units = row?.value ?? 0
        lines.push({
          product: product.id,
          productName: product.name,
          meter: price.meter,
          aggregation: row?.aggregation ?? "cost",
          units,
          includedUnits: 0,
          includedUsed: null,
          perUnitMinor: units > 0 ? accrued / units : 0,
          accruedMinor: accrued,
          costMinor: attributedCost,
          projectedUnits: units * runRate,
          projectedMinor: accrued * runRate,
          marginTarget: price.margin
        })
      }
    }

    let baseMinor = 0
    if (attributed.size > 0 && overrideRecurring.length > 0) {
      // A negotiated recurring price replaces the list base fees outright.
      for (const price of overrideRecurring) {
        if (price.type !== "recurring") continue
        currency = price.amount.currency
        baseMinor += Number(price.amount.amount) * (INTERVAL_TO_30D[price.interval] ?? 1)
      }
    } else {
      for (const product of attributed.values()) {
        for (const price of product.prices) {
          if (price.type !== "recurring") continue
          currency = price.amount.currency
          baseMinor += Number(price.amount.amount) * (INTERVAL_TO_30D[price.interval] ?? 1)
        }
      }
    }

    const accruedMinor = lines.reduce((sum, line) => sum + line.accruedMinor, 0)
    const projectedMetered = lines.reduce((sum, line) => sum + line.projectedMinor, 0)

    const costsByEvent = costsFor(customer)
    const costMinor = costsByEvent.reduce((sum, entry) => sum + entry.costMinor, 0)
    const projectedCostMinor = costMinor * runRate

    // Apply the cap: the base bills first, usage charges absorb the clamp.
    const uncappedSpendMinor = baseMinor + accruedMinor
    let billedAccrued = accruedMinor
    let cappedMinor = 0
    if (capMinor !== null && uncappedSpendMinor > capMinor) {
      cappedMinor = uncappedSpendMinor - capMinor
      billedAccrued = Math.max(0, capMinor - baseMinor)
    }
    const uncappedProjected = baseMinor + projectedMetered
    const projectedMinor =
      capMinor !== null ? Math.min(uncappedProjected, capMinor) : uncappedProjected

    customers.push({
      customer,
      products: [...attributed.values()].map((product) => product.name),
      baseMinor,
      accruedMinor: billedAccrued,
      projectedMinor,
      uncappedSpendMinor,
      capMinor,
      cappedMinor,
      costMinor,
      projectedCostMinor,
      marginPct:
        projectedMinor > 0 ? (projectedMinor - projectedCostMinor) / projectedMinor : null,
      costsByEvent,
      currency,
      lines: lines.sort((a, b) => b.projectedMinor - a.projectedMinor)
    })
  }

  customers.sort(
    (a, b) => b.projectedMinor - a.projectedMinor || a.customer.localeCompare(b.customer)
  )

  const totalProjected = customers.reduce((sum, c) => sum + c.projectedMinor, 0)
  const totalProjectedCost = customers.reduce((sum, c) => sum + c.projectedCostMinor, 0)

  return {
    customers,
    totals: {
      baseMinor: customers.reduce((sum, c) => sum + c.baseMinor, 0),
      accruedMinor: customers.reduce((sum, c) => sum + c.accruedMinor, 0),
      projectedMinor: totalProjected,
      costMinor: customers.reduce((sum, c) => sum + c.costMinor, 0),
      projectedCostMinor: totalProjectedCost,
      marginPct:
        totalProjected > 0 ? (totalProjected - totalProjectedCost) / totalProjected : null,
      cappedMinor: customers.reduce((sum, c) => sum + c.cappedMinor, 0),
      currency
    },
    elapsedDays
  }
}

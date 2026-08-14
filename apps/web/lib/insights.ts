import type { BillingIr } from "@void/compiler"
import { formatMinor } from "./format"
import type { RevenuePoint } from "./series"
import type { SpendOverview } from "./spend"
import type { UsageRow } from "./types"

export interface Highlight {
  readonly tone: "ok" | "warn" | "neutral"
  readonly text: string
}

/**
 * Relative change of the recent earning pace vs the whole period: the accrual
 * rate over the last quarter of the observed window compared to the overall
 * rate. Returns null when there isn't enough history to say anything honest.
 */
export const paceDelta = (series: ReadonlyArray<RevenuePoint>): number | null => {
  if (series.length < 8) return null
  const first = series[0]!
  const last = series[series.length - 1]!
  const span = last.t - first.t
  if (span <= 0 || last.accruedMinor <= 0) return null

  const cutoff = last.t - span / 4
  const recentStart =
    [...series].reverse().find((point) => point.t <= cutoff) ?? first
  const recentSpan = last.t - recentStart.t
  if (recentSpan <= 0) return null

  const overallRate = last.accruedMinor / span
  const recentRate = (last.accruedMinor - recentStart.accruedMinor) / recentSpan
  if (overallRate === 0) return null
  return recentRate / overallRate - 1
}

/** Customers currently earning overage (usage beyond an included allowance). */
export const overageCustomers = (spend: SpendOverview): ReadonlyArray<string> =>
  spend.customers
    .filter((customer) =>
      customer.lines.some((line) => line.includedUsed !== null && line.includedUsed > 1)
    )
    .map((customer) => customer.customer)

/** Meters with recorded usage that no product prices — unmonetized activity. */
export const unpricedMeters = (
  usage: ReadonlyArray<UsageRow>,
  ir: BillingIr
): ReadonlyArray<string> => {
  const priced = new Set(
    ir.products.flatMap((product) =>
      product.prices.flatMap((price) =>
        price.type === "metered" || price.type === "metered_margin" ? [price.meter] : []
      )
    )
  )
  return [...new Set(usage.map((row) => row.meter))].filter((meter) => !priced.has(meter))
}

export const highlights = (
  spend: SpendOverview,
  usage: ReadonlyArray<UsageRow>,
  ir: BillingIr,
  revenue: ReadonlyArray<RevenuePoint>
): ReadonlyArray<Highlight> => {
  const items: Array<Highlight> = []

  const top = spend.customers[0]
  if (top !== undefined && spend.totals.projectedMinor > 0 && spend.customers.length > 1) {
    const share = top.projectedMinor / spend.totals.projectedMinor
    items.push({
      tone: share > 0.5 ? "warn" : "neutral",
      text:
        share > 0.5
          ? `${top.customer} drives ${Math.round(share * 100)}% of expected revenue — a concentration risk`
          : `${top.customer} is your top customer at ${Math.round(share * 100)}% of expected revenue`
    })
  }

  const over = overageCustomers(spend)
  if (over.length > 0) {
    items.push({
      tone: "ok",
      text:
        over.length === 1
          ? `${over[0]} has used up their included allowance and is now billing overage`
          : `${over.length} customers are past their included allowances and billing overage`
    })
  }

  const delta = paceDelta(revenue)
  if (delta !== null && Math.abs(delta) >= 0.1) {
    items.push({
      tone: delta > 0 ? "ok" : "warn",
      text:
        delta > 0
          ? `Earning pace is up ${Math.round(delta * 100)}% recently`
          : `Earning pace is down ${Math.round(Math.abs(delta) * 100)}% recently`
    })
  }

  const unpriced = unpricedMeters(usage, ir)
  if (unpriced.length > 0) {
    items.push({
      tone: "warn",
      text: `Usage on ${unpriced.join(", ")} isn't priced by any product — it earns nothing`
    })
  }

  const losing = spend.customers.filter(
    (customer) => customer.marginPct !== null && customer.marginPct < 0
  )
  if (losing.length > 0) {
    items.push({
      tone: "warn",
      text:
        losing.length === 1
          ? `You're losing money on ${losing[0]!.customer} — its costs exceed its revenue`
          : `You're losing money on ${losing.length} customers — their costs exceed their revenue`
    })
  }

  if (spend.totals.cappedMinor > 0) {
    const capped = spend.customers.filter((customer) => customer.cappedMinor > 0)
    items.push({
      tone: "neutral",
      text: `Bill caps absorbed ${formatMinor(spend.totals.cappedMinor, spend.totals.currency)} this period across ${capped.length} customer${capped.length === 1 ? "" : "s"}`
    })
  }

  const foreign = [
    ...new Set(
      spend.customers
        .flatMap((customer) => customer.costsByEvent)
        .filter((entry) => entry.currency !== spend.totals.currency)
        .map((entry) => entry.currency)
    )
  ]
  if (foreign.length > 0) {
    items.push({
      tone: "warn",
      text: `Some costs are reported in ${foreign.join(", ")} but pricing is in ${spend.totals.currency} — margins don't convert currencies`
    })
  }

  const margin = spend.totals.marginPct
  if (margin !== null && spend.totals.projectedCostMinor > 0) {
    if (margin < 0.2) {
      items.push({
        tone: "warn",
        text: `Overall gross margin is ${Math.round(margin * 100)}% — thin for a usage business`
      })
    } else if (margin >= 0.5) {
      items.push({
        tone: "ok",
        text: `Healthy gross margin: ${Math.round(margin * 100)}% after reported costs`
      })
    }
  }

  return items
}

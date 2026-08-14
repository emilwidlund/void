import type { BillingIr } from "@void/compiler"
import { computeSpend } from "./spend"
import type { HistoryPoint } from "./types"

export interface RevenuePoint {
  readonly t: number
  /** accrued metered revenue at this point, in minor units */
  readonly accruedMinor: number
}

/** Narrows every history point to a single customer's usage rows. */
export const filterHistory = (
  history: ReadonlyArray<HistoryPoint>,
  customer: string
): ReadonlyArray<HistoryPoint> =>
  history.map((point) => ({
    at: point.at,
    usage: point.usage.filter((row) => row.customer === customer)
  }))

/** Accrued metered revenue at each history point, priced with the active config. */
export const revenueSeries = (
  history: ReadonlyArray<HistoryPoint>,
  ir: BillingIr,
  deployedAt: string
): ReadonlyArray<RevenuePoint> =>
  history.map((point) => ({
    t: new Date(point.at).getTime(),
    accruedMinor: computeSpend(point.usage, ir, deployedAt, new Date(point.at)).totals
      .accruedMinor
  }))

export interface MeterPoint {
  readonly t: number
  readonly combined: number
}

export interface MeterSeries {
  readonly meter: string
  readonly aggregation: string
  readonly current: number
  readonly points: ReadonlyArray<MeterPoint>
}

/** Combined usage (across customers) over time, one series per meter. */
export const meterSeries = (
  history: ReadonlyArray<HistoryPoint>
): ReadonlyArray<MeterSeries> => {
  const meters = new Map<string, { aggregation: string; points: Array<MeterPoint> }>()
  for (const point of history) {
    const t = new Date(point.at).getTime()
    const combined = new Map<string, { aggregation: string; total: number }>()
    for (const row of point.usage) {
      const entry = combined.get(row.meter) ?? { aggregation: row.aggregation, total: 0 }
      entry.total += row.value
      combined.set(row.meter, entry)
    }
    for (const [meter, { aggregation, total }] of combined) {
      const series = meters.get(meter) ?? { aggregation, points: [] }
      series.points.push({ t, combined: total })
      meters.set(meter, series)
    }
  }
  return [...meters.entries()]
    .map(([meter, { aggregation, points }]) => ({
      meter,
      aggregation,
      current: points[points.length - 1]?.combined ?? 0,
      points
    }))
    .sort((a, b) => a.meter.localeCompare(b.meter))
}

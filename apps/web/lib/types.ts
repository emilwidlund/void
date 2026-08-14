import type { BillingIr } from "@void/compiler"

export interface UsageRow {
  readonly meter: string
  readonly customer: string
  readonly aggregation: string
  readonly value: number
}

export interface ActiveConfig {
  readonly version: number
  readonly checksum: string
  readonly deployed_at: string
  readonly source: string | null
  readonly meters: number
  readonly products: number
  readonly ir: BillingIr
}

/** Accumulated `_cost` for one customer, event name and currency, in minor units. */
export interface CostRow {
  readonly customer: string
  readonly event: string
  readonly currency: string
  readonly cost_minor: number
}

/** `_cost` attributed to a meter whose filter matched the event. */
export interface MeterCostRow {
  readonly meter: string
  readonly customer: string
  readonly currency: string
  readonly cost_minor: number
}

export interface HistoryPoint {
  readonly at: string
  readonly usage: ReadonlyArray<UsageRow>
  readonly costs: ReadonlyArray<CostRow>
  readonly meter_costs: ReadonlyArray<MeterCostRow>
}

export interface DashboardData {
  readonly usage: ReadonlyArray<UsageRow>
  readonly config: ActiveConfig | null
  readonly history: ReadonlyArray<HistoryPoint>
  readonly costs: ReadonlyArray<CostRow>
  readonly meter_costs: ReadonlyArray<MeterCostRow>
}

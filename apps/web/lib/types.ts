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

export interface DashboardData {
  readonly usage: ReadonlyArray<UsageRow>
  readonly config: ActiveConfig | null
}

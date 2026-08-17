/**
 * The typed configuration surface of `defineBilling` — the TypeScript
 * frontend to void. Everything here compiles to the same checksummed IR as
 * `.void` files, so both frontends share one deploy pipeline.
 */

// ---------------------------------------------------------------------------
// Value literals
// ---------------------------------------------------------------------------

export interface Money {
  readonly amount: number
  readonly currency: string
  /** true when `amount` is already in minor units (cents) */
  readonly minor: boolean
}

/** `usd(29)` — major units (dollars). */
export const usd = (amount: number): Money => ({ amount, currency: "USD", minor: false })
/** `usdCents(10)` — minor units; sub-cent unit prices stay exact. */
export const usdCents = (amount: number): Money => ({
  amount,
  currency: "USD",
  minor: true
})
export const money = (
  amount: number,
  currency: string,
  options?: { readonly minor?: boolean }
): Money => ({ amount, currency, minor: options?.minor ?? false })

export type Percent = `${number}%`
export type SpanUnit = "ms" | "seconds" | "minutes" | "hours" | "days"
export type Span = `${number} ${SpanUnit}`
export type UnitName =
  | "scalar"
  | "ms"
  | "seconds"
  | "minutes"
  | "hours"
  | "days"
  | "bytes"
  | "kb"
  | "mb"
  | "gb"
  | "tb"
export type Interval = "month" | "year" | "week" | "day"
export type Behavior = "warn" | "cap" | "block" | "notify"
export type IsoDate = `${number}-${number}-${number}`

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface Comparison {
  readonly op: "gt" | "gte" | "lt" | "lte" | "ne"
  readonly value: number | string | boolean
}

export type MatcherValue = string | number | boolean | Comparison
export type Matcher = Readonly<Record<string, MatcherValue>>

export interface Filter<E extends string = string> {
  readonly event?: E
  readonly where?: Matcher
}

/**
 * `on("compute.done", { status: "success" })` — event name plus property
 * matchers. The event name is preserved as a literal type, which is what
 * feeds `track()` autocomplete.
 */
export const on = <E extends string>(event: E, where?: Matcher): Filter<E> =>
  where !== undefined ? { event, where } : { event }

/** Property matchers for non-equality: `{ status_code: gte(500) }`. */
export const gt = (value: number): Comparison => ({ op: "gt", value })
export const gte = (value: number): Comparison => ({ op: "gte", value })
export const lt = (value: number): Comparison => ({ op: "lt", value })
export const lte = (value: number): Comparison => ({ op: "lte", value })
export const not = (value: number | string | boolean): Comparison => ({
  op: "ne",
  value
})

export const isComparison = (value: MatcherValue): value is Comparison =>
  typeof value === "object" && value !== null && "op" in value && "value" in value

// ---------------------------------------------------------------------------
// Meters (standard aggregations and outcome chains share one namespace)
// ---------------------------------------------------------------------------

export type AggregateSpec =
  | "count"
  | { readonly sum: string }
  | { readonly max: string }
  | { readonly min: string }
  | { readonly avg: string }
  | { readonly unique: string }

export interface StandardMeterConfig {
  readonly filter?: Filter
  readonly aggregate: AggregateSpec
  readonly unit?: UnitName
  /** correction rule: a matching event unwinds one prior charge */
  readonly reverseOn?: { readonly on: Filter; readonly within?: Span }
}

/** Success as a correlated chain: steps in order, completion bills one unit. */
export interface OutcomeMeterConfig {
  /** event property identifying one instance (e.g. "ticket_id") */
  readonly correlate: string
  readonly steps: ReadonlyArray<Filter>
  readonly failOn?: { readonly on: Filter; readonly within?: Span }
}

export type MeterConfig = StandardMeterConfig | OutcomeMeterConfig

export const isOutcomeConfig = (meter: MeterConfig): meter is OutcomeMeterConfig =>
  "correlate" in meter

// ---------------------------------------------------------------------------
// Products, entitlements, pricing
// ---------------------------------------------------------------------------

export type UsagePricing<Id extends string = string> =
  | {
      readonly perUnit: Money
      readonly per?: UnitName
      readonly included?: number
    }
  | { readonly margin: Percent }

export type EntitlementConfig<Id extends string = string> =
  | true
  | { readonly limit: number }
  | { readonly meter: Id; readonly limit: number }

export interface ProductConfig<Id extends string = string> {
  readonly name: string
  readonly price?: { readonly every: Interval; readonly amount: Money }
  readonly entitlements?: Readonly<Record<string, EntitlementConfig<Id>>>
  /** meters and outcomes priced by this product, keyed by declaration */
  readonly usage?: Partial<Readonly<Record<Id, UsagePricing<Id>>>>
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

type MoneyOp =
  | { readonly gte: Money }
  | { readonly lte: Money }
  | { readonly gt: Money }
  | { readonly lt: Money }
type PercentOp =
  | { readonly gte: Percent }
  | { readonly lte: Percent }
  | { readonly gt: Percent }
  | { readonly lt: Percent }

export type InvariantAssert<Id extends string = string> =
  | ({ readonly price: Id } & MoneyOp)
  | ({ readonly margin: Id | "customer" } & PercentOp)
  | ({ readonly spend: "customer" } & MoneyOp)

export interface InvariantConfig<Id extends string = string> {
  readonly name: string
  readonly assert: InvariantAssert<Id>
  readonly else?: Behavior
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

export interface OverrideConfig<Id extends string = string> {
  readonly until?: IsoDate
  readonly price?: { readonly every: Interval; readonly amount: Money }
  readonly usage?: Partial<Readonly<Record<Id, UsagePricing<Id>>>>
  readonly entitlements?: Readonly<Record<string, EntitlementConfig<Id>>>
}

// ---------------------------------------------------------------------------
// The whole config
// ---------------------------------------------------------------------------

/** Meter/outcome ids declared by a config — the checked reference namespace. */
export type MeterIdOf<C> = C extends { readonly meters: infer M }
  ? keyof M & string
  : string

export interface BillingConfigShape<C> {
  readonly meters: Readonly<Record<string, MeterConfig>>
  readonly products: Readonly<Record<string, ProductConfig<MeterIdOf<C>>>>
  readonly invariants?: ReadonlyArray<InvariantConfig<MeterIdOf<C>>>
  readonly overrides?: Readonly<Record<string, OverrideConfig<MeterIdOf<C>>>>
}

export type ProductIdOf<C> = C extends { readonly products: infer P }
  ? keyof P & string
  : string

/** A closed union for autocomplete that still accepts any string. */
export type Suggest<T extends string> = T | (string & Record<never, never>)

type EventOfFilter<F> = F extends { readonly event?: infer E }
  ? E extends string
    ? E
    : never
  : never

type EventsOfMeter<M> =
  | (M extends { readonly filter: infer F } ? EventOfFilter<F> : never)
  | (M extends { readonly reverseOn: { readonly on: infer F } }
      ? EventOfFilter<F>
      : never)
  | (M extends { readonly steps: ReadonlyArray<infer F> } ? EventOfFilter<F> : never)
  | (M extends { readonly failOn: { readonly on: infer F } } ? EventOfFilter<F> : never)

/**
 * Every event name the config mentions — meter filters, correction rules,
 * outcome steps and fail conditions. Powers `track()` autocomplete.
 */
export type EventNameOf<C> = C extends { readonly meters: infer M }
  ? { [K in keyof M]: EventsOfMeter<M[K]> }[keyof M] & string
  : string

/** Every entitlement id granted by any product or override in the config. */
export type EntitlementIdOf<C> = C extends {
  readonly products: infer P
}
  ?
      | {
          [K in keyof P]: P[K] extends { readonly entitlements?: infer E }
            ? keyof NonNullable<E>
            : never
        }[keyof P]
      | (C extends { readonly overrides?: infer O }
          ? {
              [K in keyof O]: O[K] extends { readonly entitlements?: infer E }
                ? keyof NonNullable<E>
                : never
            }[keyof O]
          : never)
  : string

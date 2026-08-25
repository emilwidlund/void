/**
 * The typed configuration surface of `defineConfig` — the TypeScript
 * frontend to void. Everything here compiles to the same checksummed IR as
 * `.void` files, so both frontends share one deploy pipeline. The `ai`
 * section is client-side behavior only and never enters the IR.
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

/** `P` suggests known event property keys (e.g. what AI events carry). */
export type AggregateSpec<P extends string = string> =
  | "count"
  | { readonly sum: Suggest<P> }
  | { readonly max: Suggest<P> }
  | { readonly min: Suggest<P> }
  | { readonly avg: Suggest<P> }
  | { readonly unique: Suggest<P> }

export interface StandardMeterConfig<P extends string = string> {
  readonly filter?: Filter
  readonly aggregate: AggregateSpec<P>
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

export type MeterConfig<P extends string = string> =
  | StandardMeterConfig<P>
  | OutcomeMeterConfig

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
// AI (client-side: how model calls turn into usage events — not part of the IR)
// ---------------------------------------------------------------------------

/** Options for sending one event — used by the client and by AI meter bindings. */
export interface TrackOptions {
  readonly customer?: string
  readonly properties?: Readonly<Record<string, string | number | boolean>>
  /** what serving this event cost you — powers margin analytics */
  readonly cost?: Money
  readonly timestamp?: string | Date
}

/** Per-million-token rates for one model. */
export interface TokenPricing {
  /** per 1M input tokens */
  readonly input?: Money
  /** per 1M output tokens */
  readonly output?: Money
  /** per 1M cached input tokens read; falls back to the `input` rate */
  readonly cachedInput?: Money
}

/**
 * Properties the `@void/sdk/ai` middleware attaches to every AI event —
 * the keys AI-event meters can aggregate and filter on. Kept in sync by the
 * middleware's return type.
 */
export type AiEventProperty =
  | "model"
  | "provider"
  | "finish_reason"
  | "streamed"
  | "duration_ms"
  | "input_tokens"
  | "output_tokens"
  | "total_tokens"
  | "cached_input_tokens"
  | "reasoning_tokens"

/** The minimal client surface an AI meter binds its model to. */
export interface AiTrackTarget {
  track(name: string, options?: TrackOptions): PromiseLike<unknown>
}

/**
 * An AI model declared as a meter — created by `metered` from `@void/sdk/ai`.
 * By default it compiles to one standard meter per token class
 * (`<key>.input_tokens`, `<key>.cached_input_tokens`, `<key>.output_tokens`,
 * all filtering the event, which defaults to `ai.<meter key>`) — token
 * classes are priced differently, so there is no single-sum default. An
 * explicit `aggregate` compiles to a single meter under the plain key
 * instead. `connect()` binds the model so the client exposes it, wrapped and
 * usage-tracked, under `client.ai.<meter key>`. The model itself never
 * enters the IR or checksum.
 */
export interface AiMeterConfig<Model = unknown> {
  readonly kind: "ai"
  /** usage event tracked per call; defaults to `ai.<meter key>` */
  readonly event?: string
  /** single-meter override; omit for the per-token-class expansion */
  readonly aggregate?: AggregateSpec<AiEventProperty>
  readonly unit?: UnitName
  /** wraps the model against a connected client — called by `connect()` */
  readonly bind: (client: AiTrackTarget, event: string) => Model
}

export const isAiConfig = (
  meter: MeterConfig | AiMeterConfig
): meter is AiMeterConfig => "kind" in meter && meter.kind === "ai"

/** The client's `ai` namespace: one bound model per AI meter, keyed by meter id. */
export type AiModelsOf<C> = C extends { readonly meters: infer M }
  ? {
      readonly [K in keyof M as M[K] extends { readonly kind: "ai" }
        ? K
        : never]: M[K] extends { readonly bind: (...args: never) => infer Model }
        ? Model
        : never
    }
  : Record<never, never>

// ---------------------------------------------------------------------------
// The whole config
// ---------------------------------------------------------------------------

/**
 * The meter ids one meters-object entry contributes. An AI meter without an
 * explicit `aggregate` expands to one meter per token class — input, cached
 * input and output are almost always priced differently, so there is no
 * single-meter default.
 */
type MeterIdsOfEntry<M, K> = M extends { readonly kind: "ai" }
  ? M extends { readonly aggregate: unknown }
    ? K & string
    :
        | `${K & string}.input_tokens`
        | `${K & string}.cached_input_tokens`
        | `${K & string}.output_tokens`
  : K & string

export type MeterIdsOf<M> = { [K in keyof M]: MeterIdsOfEntry<M[K], K> }[keyof M] &
  string

/** Meter/outcome ids declared by a config — the checked reference namespace. */
export type MeterIdOf<C> = C extends { readonly meters: infer M }
  ? MeterIdsOf<M>
  : string

/**
 * The runtime shape `compileConfig` consumes. `defineConfig`'s signature
 * spells out the same positions with per-section generics — that split (not
 * one self-referential parameter) is what makes cross-references autocomplete.
 */
export interface ConfigShape {
  readonly meters: Readonly<Record<string, MeterConfig | AiMeterConfig>>
  readonly products: Readonly<Record<string, ProductConfig>>
  readonly invariants?: ReadonlyArray<InvariantConfig>
  readonly overrides?: Readonly<Record<string, OverrideConfig>>
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

/** The event an AI meter tracks: its declared `event`, else `ai.<meter key>`. */
type AiEventOfMeter<M, K> = M extends { readonly kind: "ai" }
  ? M extends { readonly event: infer E extends string }
    ? E
    : `ai.${K & string}`
  : never

/**
 * Every event name the config mentions — meter filters, correction rules,
 * outcome steps, fail conditions and AI meters (whose event defaults to
 * `ai.<meter key>`). Powers `track()` autocomplete.
 */
export type EventNameOf<C> = C extends { readonly meters: infer M }
  ? {
      [K in keyof M]: EventsOfMeter<M[K]> | AiEventOfMeter<M[K], K>
    }[keyof M] &
      string
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

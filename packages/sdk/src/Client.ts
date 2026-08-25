import type { BillingIr } from "@void/compiler"
import type { TrackOptions } from "./Config.js"

/**
 * A typed client for a void server, bound to one compiled config. Meter,
 * product and entitlement ids are literal types derived from the config, so
 * `client.allowed("acme", "ssso")` is a compile error.
 */

export interface ClientOptions {
  /** void server base URL, e.g. "http://localhost:4000" */
  readonly endpoint: string
  readonly token?: string
  readonly fetch?: typeof fetch
}


export interface DeployResult {
  readonly status: "accepted" | "unchanged"
  readonly version: number
}

/** `DeployResult` plus a sync convenience flag. */
export interface DeploySnapshot extends DeployResult {
  /** true when this deploy activated a new version (status === "accepted") */
  readonly changed: boolean
}

export interface IngestResult {
  readonly ingested: number
  readonly matched: Readonly<Record<string, number>>
  readonly reversed: Readonly<Record<string, number>>
  readonly cost_minor: number
}

/** `IngestResult` plus sync per-meter lookups (0 when the meter didn't fire). */
export interface IngestSnapshot<MeterId extends string = string> extends IngestResult {
  matchedOn(meter: Suggest<MeterId>): number
  reversedOn(meter: Suggest<MeterId>): number
}

export interface UsageRow<MeterId extends string = string> {
  readonly meter: MeterId
  readonly customer: string
  readonly aggregation: string
  readonly value: number
}

/**
 * What `client.usage()` resolves to: still the plain array of rows
 * (iterate/filter/serialize as before), with sync slicing helpers attached.
 */
export type UsageSnapshot<MeterId extends string = string> = ReadonlyArray<
  UsageRow<MeterId>
> & {
  for(customer: string): ReadonlyArray<UsageRow<MeterId>>
  meter(meter: MeterId): ReadonlyArray<UsageRow<MeterId>>
  /** summed value for a meter, optionally scoped to one customer */
  total(meter: MeterId, customer?: string): number
}

export type EntitlementStatus<Id extends string = string> =
  | { readonly id: Id; readonly product: string; readonly type: "flag" }
  | { readonly id: Id; readonly product: string; readonly type: "limit"; readonly limit: number }
  | {
      readonly id: Id
      readonly product: string
      readonly type: "metered"
      readonly meter: string
      readonly limit: number
      readonly used: number
      readonly remaining: number
      readonly exceeded: boolean
    }

export interface CustomerEntitlements<Id extends string = string> {
  readonly customer: string
  readonly products: ReadonlyArray<string>
  readonly entitlements: ReadonlyArray<EntitlementStatus<Id>>
  readonly enforcement: "ok" | "blocked"
  readonly violations: ReadonlyArray<{
    readonly invariant: string
    readonly behavior: "warn" | "cap" | "block" | "notify" | null
  }>
}

/**
 * What `client.entitlements()` resolves to: the raw status plus sync gates,
 * so one await covers any number of checks:
 *
 *   const acme = await client.entitlements("acme")
 *   if (!acme.allowed("ai_agent")) ...
 *   if (!acme.allowed("reply_quota")) ...
 */
export interface EntitlementsSnapshot<Id extends string = string>
  extends CustomerEntitlements<Id> {
  /** false when enforcement is "blocked", not granted, or a metered entitlement is exceeded */
  allowed(entitlement: Id): boolean
  get(entitlement: Id): EntitlementStatus<Id> | undefined
  /** remaining units of a metered entitlement; null for flags/limits or when not granted */
  remaining(entitlement: Id): number | null
}

/** Known names autocomplete; any other string is still accepted. */
type Suggest<T extends string> = T | (string & Record<never, never>)

/**
 * An awaitable request with chainable helpers, so no parenthesized awaits:
 * `await client.entitlements("acme")` resolves the full result, while
 * `await client.entitlements("acme").allowed("sso")` answers one question.
 */
export interface Query<T> extends PromiseLike<T> {
  catch<R = never>(
    onRejected?: ((reason: unknown) => R | PromiseLike<R>) | null
  ): Promise<T | R>
}

/**
 * Lazy handle on one customer's entitlements: nothing is fetched until the
 * query (or a helper) is awaited, and every helper shares a single fetch —
 * gating on two entitlements costs one round-trip.
 */
export interface EntitlementsQuery<Id extends string = string>
  extends Query<EntitlementsSnapshot<Id>> {
  allowed(entitlement: Id): Promise<boolean>
  get(entitlement: Id): Promise<EntitlementStatus<Id> | undefined>
  remaining(entitlement: Id): Promise<number | null>
}

/** Lazy handle on aggregated usage, same single-fetch chaining. */
export interface UsageQuery<MeterId extends string = string>
  extends Query<UsageSnapshot<MeterId>> {
  for(customer: string): Promise<ReadonlyArray<UsageRow<MeterId>>>
  meter(meter: MeterId): Promise<ReadonlyArray<UsageRow<MeterId>>>
  total(meter: MeterId, customer?: string): Promise<number>
}

/**
 * The in-flight ingest (the request fires immediately — events are never
 * lost to an unawaited chain) with chainable result helpers.
 */
export interface IngestQuery<MeterId extends string = string>
  extends Query<IngestSnapshot<MeterId>> {
  matchedOn(meter: Suggest<MeterId>): Promise<number>
  reversedOn(meter: Suggest<MeterId>): Promise<number>
}

export interface VoidClient<
  MeterId extends string = string,
  EntitlementId extends string = string,
  EventName extends string = string
> {
  /** Deploy this config's checksummed IR (no-op if already active). */
  deploy(): Promise<DeploySnapshot>
  /**
   * Send one event. Names mentioned by the config (meter filters, outcome
   * steps, corrections) autocomplete; unknown names are allowed — they're
   * simply unmetered (but may still carry `cost`).
   */
  track(name: Suggest<EventName>, options?: TrackOptions): IngestQuery<MeterId>
  /** Send a batch of events. */
  ingest(
    events: ReadonlyArray<{ readonly name: Suggest<EventName> } & TrackOptions>
  ): IngestQuery<MeterId>
  /**
   * Aggregated usage per meter/outcome and customer. Await it for the rows,
   * or chain: `await client.usage().total("api_calls", "acme")`.
   */
  usage(): UsageQuery<MeterId>
  /**
   * The customer's entitlements, enforcement state and violated invariants.
   * Await it for the full snapshot (with sync `allowed`/`get`/`remaining`),
   * or chain: `await client.entitlements("acme").allowed("sso")`.
   */
  entitlements(customer: string): EntitlementsQuery<EntitlementId>
  /** Shorthand for `entitlements(customer).allowed(entitlement)`. */
  allowed(customer: string, entitlement: EntitlementId): Promise<boolean>
}

interface Wire {
  request(path: string, init?: RequestInit): Promise<unknown>
}

const wire = (options: ClientOptions): Wire => {
  const doFetch = options.fetch ?? fetch
  return {
    async request(path, init) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(options.token !== undefined
          ? { authorization: `Bearer ${options.token}` }
          : {})
      }
      const response = await doFetch(`${options.endpoint}${path}`, { ...init, headers })
      const body = (await response.json().catch(() => ({}))) as unknown
      if (!response.ok) {
        const message =
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: unknown }).error)
            : `${response.status}`
        throw new Error(`void server: ${message}`)
      }
      return body
    }
  }
}

/** One fetch shared by the query itself and all of its chained helpers. */
const lazy = <T>(fetchValue: () => Promise<T>): (() => Promise<T>) => {
  let cached: Promise<T> | undefined
  return () => (cached ??= fetchValue())
}

const entitlementsQuery = <Id extends string>(
  fetchSnapshot: () => Promise<EntitlementsSnapshot<Id>>
): EntitlementsQuery<Id> => {
  const resolved = lazy(fetchSnapshot)
  return {
    then: (onFulfilled, onRejected) => resolved().then(onFulfilled, onRejected),
    catch: (onRejected) => resolved().then(undefined, onRejected),
    allowed: (entitlement) => resolved().then((s) => s.allowed(entitlement)),
    get: (entitlement) => resolved().then((s) => s.get(entitlement)),
    remaining: (entitlement) => resolved().then((s) => s.remaining(entitlement))
  }
}

const usageQuery = <MeterId extends string>(
  fetchSnapshot: () => Promise<UsageSnapshot<MeterId>>
): UsageQuery<MeterId> => {
  const resolved = lazy(fetchSnapshot)
  return {
    then: (onFulfilled, onRejected) => resolved().then(onFulfilled, onRejected),
    catch: (onRejected) => resolved().then(undefined, onRejected),
    for: (customer) => resolved().then((s) => s.for(customer)),
    meter: (meter) => resolved().then((s) => s.meter(meter)),
    total: (meter, customer) => resolved().then((s) => s.total(meter, customer))
  }
}

/** Eager on purpose: the events are sent whether or not anyone awaits. */
const ingestQuery = <MeterId extends string>(
  result: Promise<IngestSnapshot<MeterId>>
): IngestQuery<MeterId> => ({
  then: (onFulfilled, onRejected) => result.then(onFulfilled, onRejected),
  catch: (onRejected) => result.then(undefined, onRejected),
  matchedOn: (meter) => result.then((s) => s.matchedOn(meter)),
  reversedOn: (meter) => result.then((s) => s.reversedOn(meter))
})

const ingestSnapshot = <MeterId extends string>(
  data: IngestResult
): IngestSnapshot<MeterId> => ({
  ...data,
  matchedOn: (meter) => data.matched[meter] ?? 0,
  reversedOn: (meter) => data.reversed[meter] ?? 0
})

const usageSnapshot = <MeterId extends string>(
  rows: ReadonlyArray<UsageRow<MeterId>>
): UsageSnapshot<MeterId> =>
  Object.assign([...rows], {
    for: (customer: string) => rows.filter((row) => row.customer === customer),
    meter: (meter: MeterId) => rows.filter((row) => row.meter === meter),
    total: (meter: MeterId, customer?: string) =>
      rows.reduce(
        (sum, row) =>
          row.meter === meter && (customer === undefined || row.customer === customer)
            ? sum + row.value
            : sum,
        0
      )
  })

const entitlementsSnapshot = <Id extends string>(
  data: CustomerEntitlements<Id>
): EntitlementsSnapshot<Id> => {
  const get = (entitlement: Id) => data.entitlements.find((e) => e.id === entitlement)
  return {
    ...data,
    get,
    allowed: (entitlement) => {
      if (data.enforcement === "blocked") return false
      const status = get(entitlement)
      if (status === undefined) return false
      return status.type === "metered" ? !status.exceeded : true
    },
    remaining: (entitlement) => {
      const status = get(entitlement)
      return status !== undefined && status.type === "metered" ? status.remaining : null
    }
  }
}

const toWireEvent = (event: { readonly name: string } & TrackOptions) => ({
  name: event.name,
  ...(event.customer !== undefined ? { external_customer_id: event.customer } : {}),
  ...(event.timestamp !== undefined
    ? {
        timestamp:
          event.timestamp instanceof Date ? event.timestamp.toISOString() : event.timestamp
      }
    : {}),
  ...(event.properties !== undefined ? { properties: event.properties } : {}),
  ...(event.cost !== undefined
    ? {
        _cost: {
          amount: event.cost.minor ? event.cost.amount / 100 : event.cost.amount,
          currency: event.cost.currency
        }
      }
    : {})
})

export const createClient = <
  MeterId extends string,
  EntitlementId extends string,
  EventName extends string
>(
  ir: BillingIr,
  checksum: string,
  options: ClientOptions
): VoidClient<MeterId, EntitlementId, EventName> => {
  const api = wire(options)
  const sendEvents = async (
    events: ReadonlyArray<{ readonly name: string } & TrackOptions>
  ): Promise<IngestSnapshot<MeterId>> =>
    ingestSnapshot(
      (await api.request("/v1/events", {
        method: "POST",
        body: JSON.stringify({ events: events.map(toWireEvent) })
      })) as IngestResult
    )
  const fetchEntitlements = async (
    customer: string
  ): Promise<EntitlementsSnapshot<EntitlementId>> =>
    entitlementsSnapshot(
      (await api.request(
        `/v1/entitlements/${encodeURIComponent(customer)}`
      )) as CustomerEntitlements<EntitlementId>
    )
  const entitlements = (customer: string): EntitlementsQuery<EntitlementId> =>
    entitlementsQuery(() => fetchEntitlements(customer))

  return {
    async deploy() {
      const result = (await api.request("/v1/deploy", {
        method: "POST",
        body: JSON.stringify({
          checksum,
          ir,
          meta: { source: "defineConfig", compiler: "@void/sdk" }
        })
      })) as DeployResult
      return { ...result, changed: result.status === "accepted" }
    },
    ingest: (events) => ingestQuery(sendEvents(events)),
    track: (name, options) => ingestQuery(sendEvents([{ name, ...options }])),
    usage: () =>
      usageQuery(async () => {
        const body = (await api.request("/v1/usage")) as {
          usage: ReadonlyArray<UsageRow<MeterId>>
        }
        return usageSnapshot(body.usage)
      }),
    entitlements,
    allowed: (customer, entitlement) => entitlements(customer).allowed(entitlement)
  }
}

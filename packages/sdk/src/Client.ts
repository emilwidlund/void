import type { BillingIr } from "@void/compiler"
import type { Money } from "./Config.js"

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

export interface TrackOptions {
  readonly customer?: string
  readonly properties?: Readonly<Record<string, string | number | boolean>>
  /** what serving this event cost you — powers margin analytics */
  readonly cost?: Money
  readonly timestamp?: string | Date
}

export interface DeployResult {
  readonly status: "accepted" | "unchanged"
  readonly version: number
}

export interface IngestResult {
  readonly ingested: number
  readonly matched: Readonly<Record<string, number>>
  readonly reversed: Readonly<Record<string, number>>
  readonly cost_minor: number
}

export interface UsageRow<MeterId extends string = string> {
  readonly meter: MeterId
  readonly customer: string
  readonly aggregation: string
  readonly value: number
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

/** Known names autocomplete; any other string is still accepted. */
type Suggest<T extends string> = T | (string & Record<never, never>)

export interface VoidClient<
  MeterId extends string = string,
  EntitlementId extends string = string,
  EventName extends string = string
> {
  /** Deploy this config's checksummed IR (no-op if already active). */
  deploy(): Promise<DeployResult>
  /**
   * Send one event. Names mentioned by the config (meter filters, outcome
   * steps, corrections) autocomplete; unknown names are allowed — they're
   * simply unmetered (but may still carry `cost`).
   */
  track(name: Suggest<EventName>, options?: TrackOptions): Promise<IngestResult>
  /** Send a batch of events. */
  ingest(
    events: ReadonlyArray<{ readonly name: Suggest<EventName> } & TrackOptions>
  ): Promise<IngestResult>
  /** Aggregated usage per meter/outcome and customer. */
  usage(): Promise<ReadonlyArray<UsageRow<MeterId>>>
  /** The customer's entitlements, enforcement state and violated invariants. */
  entitlements(customer: string): Promise<CustomerEntitlements<EntitlementId>>
  /**
   * Convenience gate: false when enforcement is "blocked", the entitlement
   * isn't granted, or a metered entitlement is exceeded.
   */
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
  const ingest = async (
    events: ReadonlyArray<{ readonly name: string } & TrackOptions>
  ): Promise<IngestResult> =>
    (await api.request("/v1/events", {
      method: "POST",
      body: JSON.stringify({ events: events.map(toWireEvent) })
    })) as IngestResult

  return {
    async deploy() {
      return (await api.request("/v1/deploy", {
        method: "POST",
        body: JSON.stringify({
          checksum,
          ir,
          meta: { source: "defineBilling", compiler: "@void/sdk" }
        })
      })) as DeployResult
    },
    ingest,
    track: (name, options) => ingest([{ name, ...options }]),
    async usage() {
      const body = (await api.request("/v1/usage")) as {
        usage: ReadonlyArray<UsageRow<MeterId>>
      }
      return body.usage
    },
    async entitlements(customer) {
      return (await api.request(
        `/v1/entitlements/${encodeURIComponent(customer)}`
      )) as CustomerEntitlements<EntitlementId>
    },
    async allowed(customer, entitlement) {
      const resolved = await this.entitlements(customer)
      if (resolved.enforcement === "blocked") return false
      const status = resolved.entitlements.find((e) => e.id === entitlement)
      if (status === undefined) return false
      return status.type === "metered" ? !status.exceeded : true
    }
  }
}

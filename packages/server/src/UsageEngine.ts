import { Data, Effect, PubSub, Ref, Stream } from "effect"
import type { ActiveDescription } from "./ConfigStore.js"
import { ConfigStore, describeActive } from "./ConfigStore.js"
import type { IngestEvent } from "./Domain.js"
import type { AggregationState } from "./Metering.js"
import { applyEvent, finalize, initialState, matchesFilter } from "./Metering.js"
import { violatedSpendInvariants } from "./Spend.js"

export class NoActiveConfig extends Data.TaggedError("NoActiveConfig")<{}> {}

export interface UsageRow {
  readonly meter: string
  readonly customer: string
  readonly aggregation: string
  readonly value: number
}

export interface IngestSummary {
  readonly ingested: number
  readonly matched: Readonly<Record<string, number>>
  /** total `_cost` accrued by this batch, in minor units */
  readonly cost_minor: number
}

/** Accumulated `_cost` for one customer, event name and currency, in minor units. */
export interface CostRow {
  readonly customer: string
  readonly event: string
  readonly currency: string
  readonly cost_minor: number
}

/**
 * `_cost` attributed to a meter: an event's cost lands on every meter whose
 * filter it matches (so overlapping meters double-count). Powers cost-derived
 * `margin` pricing.
 */
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

export type EntitlementStatus =
  | { readonly id: string; readonly product: string; readonly type: "flag" }
  | {
      readonly id: string
      readonly product: string
      readonly type: "limit"
      readonly limit: number
    }
  | {
      readonly id: string
      readonly product: string
      readonly type: "metered"
      readonly meter: string
      readonly limit: number
      readonly used: number
      readonly remaining: number
      readonly exceeded: boolean
    }

export interface CustomerEntitlements {
  readonly customer: string
  readonly products: ReadonlyArray<string>
  readonly entitlements: ReadonlyArray<EntitlementStatus>
  /** "blocked" when a violated invariant carries `else block` — the
   *  application is expected to stop serving this customer. */
  readonly enforcement: "ok" | "blocked"
  /** customer-scoped `spend` invariants currently violated, with remedies */
  readonly violations: ReadonlyArray<{
    readonly invariant: string
    readonly behavior: "warn" | "cap" | "block" | "notify" | null
  }>
}

/** How many change-points of usage history are retained for charts. */
const HISTORY_LIMIT = 600

/** Full dashboard state, pushed over SSE whenever usage or config changes. */
export interface Snapshot {
  readonly usage: ReadonlyArray<UsageRow>
  readonly config: ActiveDescription | null
  readonly history: ReadonlyArray<HistoryPoint>
  readonly costs: ReadonlyArray<CostRow>
  readonly meter_costs: ReadonlyArray<MeterCostRow>
}

/** meter id -> customer id -> aggregation state */
type UsageState = ReadonlyMap<string, ReadonlyMap<string, AggregationState>>

export class UsageEngine extends Effect.Service<UsageEngine>()("UsageEngine", {
  effect: Effect.gen(function* () {
    const configs = yield* ConfigStore
    const state = yield* Ref.make<UsageState>(new Map())
    /** customer id -> "<event>\u0000<currency>" -> accumulated cost in minor units */
    const costState = yield* Ref.make<ReadonlyMap<string, ReadonlyMap<string, number>>>(
      new Map()
    )
    /** meter id -> "<customer>\u0000<currency>" -> accumulated cost in minor units */
    const meterCostState = yield* Ref.make<
      ReadonlyMap<string, ReadonlyMap<string, number>>
    >(new Map())
    const history = yield* Ref.make<ReadonlyArray<HistoryPoint>>([])
    const changesHub = yield* PubSub.unbounded<Snapshot>()

    const ingest = (
      events: ReadonlyArray<IngestEvent>
    ): Effect.Effect<IngestSummary, NoActiveConfig> =>
      Effect.gen(function* () {
        const active = yield* configs.active
        if (active === undefined) {
          return yield* new NoActiveConfig()
        }
        const matched: Record<string, number> = {}
        let batchCostMinor = 0
        yield* Ref.update(costState, (current) => {
          const next = new Map<string, Map<string, number>>()
          for (const [customer, byEvent] of current) {
            next.set(customer, new Map(byEvent))
          }
          for (const event of events) {
            if (event._cost === undefined || event._cost.amount === 0) continue
            // major -> minor units, rounded to micro-cents to avoid float dust
            const costMinor = Math.round(event._cost.amount * 100 * 1e6) / 1e6
            batchCostMinor += costMinor
            const customer = event.external_customer_id ?? "anonymous"
            const key = `${event.name}\u0000${event._cost.currency}`
            const byEvent = next.get(customer) ?? new Map<string, number>()
            byEvent.set(key, (byEvent.get(key) ?? 0) + costMinor)
            next.set(customer, byEvent)
          }
          return next
        })
        yield* Ref.update(meterCostState, (current) => {
          const next = new Map<string, Map<string, number>>()
          for (const [meterId, byKey] of current) {
            next.set(meterId, new Map(byKey))
          }
          for (const event of events) {
            if (event._cost === undefined || event._cost.amount === 0) continue
            const costMinor = Math.round(event._cost.amount * 100 * 1e6) / 1e6
            const customer = event.external_customer_id ?? "anonymous"
            const key = `${customer}\u0000${event._cost.currency}`
            for (const meter of active.ir.meters) {
              if (!matchesFilter(meter.filter, event)) continue
              const byKey = next.get(meter.id) ?? new Map<string, number>()
              byKey.set(key, (byKey.get(key) ?? 0) + costMinor)
              next.set(meter.id, byKey)
            }
          }
          return next
        })
        yield* Ref.update(state, (current) => {
          const next = new Map<string, Map<string, AggregationState>>()
          for (const [meterId, byCustomer] of current) {
            next.set(meterId, new Map(byCustomer))
          }
          for (const event of events) {
            for (const meter of active.ir.meters) {
              if (!matchesFilter(meter.filter, event)) continue
              matched[meter.id] = (matched[meter.id] ?? 0) + 1
              const customer = event.external_customer_id ?? "anonymous"
              const byCustomer = next.get(meter.id) ?? new Map<string, AggregationState>()
              const previous = byCustomer.get(customer) ?? initialState(meter.aggregation)
              byCustomer.set(customer, applyEvent(previous, meter.aggregation, event))
              next.set(meter.id, byCustomer)
            }
          }
          return next
        })
        yield* notify
        return {
          ingested: events.length,
          matched,
          cost_minor: Math.round(batchCostMinor * 1e6) / 1e6
        }
      })

    const usage: Effect.Effect<ReadonlyArray<UsageRow>> = Ref.get(state).pipe(
      Effect.map((current) => {
        const rows: Array<UsageRow> = []
        for (const [meter, byCustomer] of current) {
          for (const [customer, aggregationState] of byCustomer) {
            rows.push({
              meter,
              customer,
              aggregation: aggregationState.type,
              value: finalize(aggregationState)
            })
          }
        }
        return rows.sort(
          (a, b) => a.meter.localeCompare(b.meter) || a.customer.localeCompare(b.customer)
        )
      })
    )

    const costs: Effect.Effect<ReadonlyArray<CostRow>> = Ref.get(costState).pipe(
      Effect.map((current) => {
        const rows: Array<CostRow> = []
        for (const [customer, byEvent] of current) {
          for (const [key, costMinor] of byEvent) {
            const [event = "", currency = ""] = key.split("\u0000")
            rows.push({ customer, event, currency, cost_minor: costMinor })
          }
        }
        return rows.sort(
          (a, b) =>
            a.customer.localeCompare(b.customer) ||
            a.event.localeCompare(b.event) ||
            a.currency.localeCompare(b.currency)
        )
      })
    )

    const meterCosts: Effect.Effect<ReadonlyArray<MeterCostRow>> = Ref.get(
      meterCostState
    ).pipe(
      Effect.map((current) => {
        const rows: Array<MeterCostRow> = []
        for (const [meter, byKey] of current) {
          for (const [key, costMinor] of byKey) {
            const [customer = "", currency = ""] = key.split("\u0000")
            rows.push({ meter, customer, currency, cost_minor: costMinor })
          }
        }
        return rows.sort(
          (a, b) =>
            a.meter.localeCompare(b.meter) ||
            a.customer.localeCompare(b.customer) ||
            a.currency.localeCompare(b.currency)
        )
      })
    )

    const snapshot: Effect.Effect<Snapshot> = Effect.gen(function* () {
      const rows = yield* usage
      const costRows = yield* costs
      const meterCostRows = yield* meterCosts
      const active = yield* configs.active
      const points = yield* Ref.get(history)
      return {
        usage: rows,
        config: describeActive(active),
        history: points,
        costs: costRows,
        meter_costs: meterCostRows
      }
    })

    /** Records a history point, then publishes the snapshot to SSE subscribers. */
    const notify = Effect.gen(function* () {
      const rows = yield* usage
      const costRows = yield* costs
      const meterCostRows = yield* meterCosts
      yield* Ref.update(history, (points) =>
        [
          ...points,
          {
            at: new Date().toISOString(),
            usage: rows,
            costs: costRows,
            meter_costs: meterCostRows
          }
        ].slice(-HISTORY_LIMIT)
      )
      yield* Effect.flatMap(snapshot, (current) => PubSub.publish(changesHub, current))
    })

    /** Emits the current snapshot immediately, then every subsequent change. */
    const changes: Stream.Stream<Snapshot> = Stream.concat(
      Stream.fromEffect(snapshot),
      Stream.fromPubSub(changesHub)
    )

    /**
     * Resolves a customer's entitlements from the active config. There is no
     * subscription data yet, so a customer is attributed to a product when
     * they have usage on one of its metered meters (the same heuristic the
     * dashboard uses); metered entitlements check live usage against `limit`.
     */
    const entitlements = (
      customer: string
    ): Effect.Effect<CustomerEntitlements, NoActiveConfig> =>
      Effect.gen(function* () {
        const active = yield* configs.active
        if (active === undefined) {
          return yield* new NoActiveConfig()
        }
        const rows = yield* usage
        const used = new Map(
          rows.filter((row) => row.customer === customer).map((row) => [row.meter, row.value])
        )
        const products = active.ir.products.filter((product) =>
          product.prices.some(
            (price) =>
              (price.type === "metered" || price.type === "metered_margin") &&
              used.has(price.meter)
          )
        )
        const statuses = products.flatMap((product) =>
          product.entitlements.map((entitlement): EntitlementStatus => {
            switch (entitlement.type) {
              case "flag":
                return { id: entitlement.id, product: product.id, type: "flag" }
              case "limit":
                return {
                  id: entitlement.id,
                  product: product.id,
                  type: "limit",
                  limit: entitlement.limit
                }
              case "metered": {
                const consumed = used.get(entitlement.meter) ?? 0
                return {
                  id: entitlement.id,
                  product: product.id,
                  type: "metered",
                  meter: entitlement.meter,
                  limit: entitlement.limit,
                  used: consumed,
                  remaining: Math.max(0, entitlement.limit - consumed),
                  exceeded: consumed > entitlement.limit
                }
              }
            }
          })
        )
        const meterCostRows = yield* meterCosts
        const violations = violatedSpendInvariants(
          customer,
          active.ir,
          rows,
          meterCostRows
        )
        return {
          customer,
          products: products.map((product) => product.id),
          entitlements: statuses,
          enforcement: violations.some((v) => v.behavior === "block")
            ? ("blocked" as const)
            : ("ok" as const),
          violations
        }
      })

    return { ingest, usage, costs, meterCosts, changes, notify, entitlements } as const
  })
}) {}

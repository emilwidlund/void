import { Data, Effect, PubSub, Ref, Stream } from "effect"
import type { ActiveDescription } from "./ConfigStore.js"
import { ConfigStore, describeActive } from "./ConfigStore.js"
import type { IngestEvent } from "./Domain.js"
import type { AggregationState } from "./Metering.js"
import {
  applyEvent,
  finalize,
  initialState,
  matchesFilter,
  resolveProperty
} from "./Metering.js"
import { activeOverride, violatedSpendInvariants } from "./Spend.js"

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
  /** reversal events applied per meter (a matching prior charge was unwound) */
  readonly reversed: Readonly<Record<string, number>>
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

/** One charge on a reversible meter, kept so a correction can unwind it. */
interface ChargeRecord {
  readonly t: number
  readonly v: number
}

/** Per-customer cap on retained charge records for reversible meters. */
const RECORD_LIMIT = 10_000

/** meter id -> { aggregation label, customer id -> charge records } */
type ReversibleState = ReadonlyMap<
  string,
  {
    readonly aggregation: string
    readonly byCustomer: ReadonlyMap<string, ReadonlyArray<ChargeRecord>>
  }
>

/** One correlated outcome chain in flight (or finished). */
interface OutcomeInstance {
  /** index of the next step to match */
  next: number
  completedAt: number | null
  failed: boolean
}

/** outcome id -> customer id -> correlation key -> instance */
type OutcomeState = ReadonlyMap<
  string,
  ReadonlyMap<string, ReadonlyMap<string, OutcomeInstance>>
>

export class UsageEngine extends Effect.Service<UsageEngine>()("UsageEngine", {
  effect: Effect.gen(function* () {
    const configs = yield* ConfigStore
    const state = yield* Ref.make<UsageState>(new Map())
    const reversibleState = yield* Ref.make<ReversibleState>(new Map())
    const outcomeState = yield* Ref.make<OutcomeState>(new Map())
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
        const reversed: Record<string, number> = {}
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
              if (meter.reverse !== null) continue // handled as charge records
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
        // Reversible meters keep individual charge records so a correction
        // event can unwind one prior charge (LIFO, within the window, never
        // below zero).
        yield* Ref.update(reversibleState, (current) => {
          const next = new Map<
            string,
            { aggregation: string; byCustomer: Map<string, Array<ChargeRecord>> }
          >()
          for (const [meterId, entry] of current) {
            next.set(meterId, {
              aggregation: entry.aggregation,
              byCustomer: new Map(
                [...entry.byCustomer].map(([customer, records]) => [customer, [...records]])
              )
            })
          }
          for (const event of events) {
            const eventTime = (() => {
              const parsed = event.timestamp !== undefined ? Date.parse(event.timestamp) : NaN
              return Number.isNaN(parsed) ? Date.now() : parsed
            })()
            for (const meter of active.ir.meters) {
              if (meter.reverse === null) continue
              const customer = event.external_customer_id ?? "anonymous"
              const entry = next.get(meter.id) ?? {
                aggregation: meter.aggregation.type,
                byCustomer: new Map<string, Array<ChargeRecord>>()
              }
              next.set(meter.id, entry)
              const records = entry.byCustomer.get(customer) ?? []
              entry.byCustomer.set(customer, records)

              if (matchesFilter(meter.filter, event)) {
                const value =
                  meter.aggregation.type === "count"
                    ? 1
                    : resolveProperty(meter.aggregation.property, event)
                if (typeof value !== "number") continue
                matched[meter.id] = (matched[meter.id] ?? 0) + 1
                records.push({ t: eventTime, v: value })
                if (records.length > RECORD_LIMIT) records.shift()
                continue
              }
              if (matchesFilter(meter.reverse.filter, event)) {
                const cutoff =
                  meter.reverse.window_s !== null
                    ? eventTime - meter.reverse.window_s * 1000
                    : Number.NEGATIVE_INFINITY
                for (let i = records.length - 1; i >= 0; i -= 1) {
                  if (records[i]!.t >= cutoff) {
                    records.splice(i, 1)
                    reversed[meter.id] = (reversed[meter.id] ?? 0) + 1
                    break
                  }
                }
              }
            }
          }
          return next
        })
        // Outcome chains: correlated instances advance step by step; the
        // final step completes (bills) one scalar unit; fail_on aborts an
        // in-flight chain or reverses a completed one within its window.
        yield* Ref.update(outcomeState, (current) => {
          const next = new Map<string, Map<string, Map<string, OutcomeInstance>>>()
          for (const [outcomeId, byCustomer] of current) {
            next.set(
              outcomeId,
              new Map(
                [...byCustomer].map(([customer, instances]) => [
                  customer,
                  new Map([...instances].map(([key, i]) => [key, { ...i }]))
                ])
              )
            )
          }
          for (const event of events) {
            const parsed = event.timestamp !== undefined ? Date.parse(event.timestamp) : NaN
            const eventTime = Number.isNaN(parsed) ? Date.now() : parsed
            const customer = event.external_customer_id ?? "anonymous"
            for (const outcome of active.ir.outcomes) {
              const keyValue = resolveProperty(outcome.correlate, event)
              if (keyValue === undefined) continue
              const key = String(keyValue)
              const byCustomer =
                next.get(outcome.id) ?? new Map<string, Map<string, OutcomeInstance>>()
              next.set(outcome.id, byCustomer)
              const instances = byCustomer.get(customer) ?? new Map<string, OutcomeInstance>()
              byCustomer.set(customer, instances)
              const instance = instances.get(key)

              if (outcome.fail !== null && matchesFilter(outcome.fail.filter, event)) {
                if (instance === undefined || instance.failed) continue
                if (instance.completedAt === null) {
                  instance.failed = true // chain aborted before completion
                } else {
                  const inWindow =
                    outcome.fail.window_s === null ||
                    eventTime - instance.completedAt <= outcome.fail.window_s * 1000
                  if (inWindow) {
                    instance.failed = true
                    reversed[outcome.id] = (reversed[outcome.id] ?? 0) + 1
                  }
                }
                continue
              }

              if (instance === undefined) {
                const first = outcome.steps[0]
                if (first === undefined || !matchesFilter(first, event)) continue
                if (instances.size >= RECORD_LIMIT) continue
                const fresh: OutcomeInstance = {
                  next: 1,
                  completedAt: outcome.steps.length === 1 ? eventTime : null,
                  failed: false
                }
                instances.set(key, fresh)
                if (fresh.completedAt !== null) {
                  matched[outcome.id] = (matched[outcome.id] ?? 0) + 1
                }
                continue
              }
              if (instance.failed || instance.completedAt !== null) continue
              const step = outcome.steps[instance.next]
              if (step === undefined || !matchesFilter(step, event)) continue
              instance.next += 1
              if (instance.next === outcome.steps.length) {
                instance.completedAt = eventTime
                matched[outcome.id] = (matched[outcome.id] ?? 0) + 1
              }
            }
          }
          return next
        })
        yield* notify
        return {
          ingested: events.length,
          matched,
          reversed,
          cost_minor: Math.round(batchCostMinor * 1e6) / 1e6
        }
      })

    const usage: Effect.Effect<ReadonlyArray<UsageRow>> = Effect.all([
      Ref.get(state),
      Ref.get(reversibleState),
      Ref.get(outcomeState)
    ]).pipe(
      Effect.map(([current, reversible, outcomes]) => {
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
        for (const [meter, entry] of reversible) {
          for (const [customer, records] of entry.byCustomer) {
            rows.push({
              meter,
              customer,
              aggregation: entry.aggregation,
              value: records.reduce((sum, record) => sum + record.v, 0)
            })
          }
        }
        for (const [outcomeId, byCustomer] of outcomes) {
          for (const [customer, instances] of byCustomer) {
            let completed = 0
            for (const instance of instances.values()) {
              if (instance.completedAt !== null && !instance.failed) completed += 1
            }
            rows.push({
              meter: outcomeId,
              customer,
              aggregation: "count",
              value: completed
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
        const toStatus = (
          entitlement: (typeof active.ir.products)[number]["entitlements"][number],
          owner: string
        ): EntitlementStatus => {
          switch (entitlement.type) {
            case "flag":
              return { id: entitlement.id, product: owner, type: "flag" }
            case "limit":
              return {
                id: entitlement.id,
                product: owner,
                type: "limit",
                limit: entitlement.limit
              }
            case "metered": {
              const consumed = used.get(entitlement.meter) ?? 0
              return {
                id: entitlement.id,
                product: owner,
                type: "metered",
                meter: entitlement.meter,
                limit: entitlement.limit,
                used: consumed,
                remaining: Math.max(0, entitlement.limit - consumed),
                exceeded: consumed > entitlement.limit
              }
            }
          }
        }

        const statuses = products.flatMap((product) =>
          product.entitlements.map((entitlement) => toStatus(entitlement, product.id))
        )
        // A customer override's entitlements replace same-id grants and can
        // add new ones on top of whatever the products grant.
        const override = activeOverride(active.ir, customer, new Date())
        if (override !== undefined) {
          for (const entitlement of override.entitlements) {
            const status = toStatus(entitlement, "override")
            const existing = statuses.findIndex((s) => s.id === entitlement.id)
            if (existing >= 0) statuses[existing] = status
            else statuses.push(status)
          }
        }
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

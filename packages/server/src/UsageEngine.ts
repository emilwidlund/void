import { Data, Effect, PubSub, Ref, Stream } from "effect"
import type { ActiveDescription } from "./ConfigStore.js"
import { ConfigStore, describeActive } from "./ConfigStore.js"
import type { IngestEvent } from "./Domain.js"
import type { AggregationState } from "./Metering.js"
import { applyEvent, finalize, initialState, matchesFilter } from "./Metering.js"

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
}

/** Full dashboard state, pushed over SSE whenever usage or config changes. */
export interface Snapshot {
  readonly usage: ReadonlyArray<UsageRow>
  readonly config: ActiveDescription | null
}

/** meter id -> customer id -> aggregation state */
type UsageState = ReadonlyMap<string, ReadonlyMap<string, AggregationState>>

export class UsageEngine extends Effect.Service<UsageEngine>()("UsageEngine", {
  effect: Effect.gen(function* () {
    const configs = yield* ConfigStore
    const state = yield* Ref.make<UsageState>(new Map())

    const ingest = (
      events: ReadonlyArray<IngestEvent>
    ): Effect.Effect<IngestSummary, NoActiveConfig> =>
      Effect.gen(function* () {
        const active = yield* configs.active
        if (active === undefined) {
          return yield* new NoActiveConfig()
        }
        const matched: Record<string, number> = {}
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
        return { ingested: events.length, matched }
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

    return { ingest, usage } as const
  })
}) {}

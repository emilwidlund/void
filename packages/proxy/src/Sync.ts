import type { IngestEvent, IngestSummary, NoActiveConfig } from "@void/server"
import { ConfigStore, UsageEngine } from "@void/server"
import { Context, Effect, Ref } from "effect"
import type { PersistenceAdapter } from "./Persistence.js"
import { filePersistence } from "./Persistence.js"

export interface ProxyConfig {
  /** parent void server base URL, e.g. https://billing.void.com */
  readonly upstream: string
  readonly token?: string
  /** where the default file journal lives (ignored when `persistence` is set) */
  readonly dataDir?: string
  /**
   * Pluggable storage: back the journal with your own database (Postgres,
   * Redis, ...) instead of local files, or `teePersistence` two adapters for
   * a dual write. Adapter failures are treated as defects.
   */
  readonly persistence?: PersistenceAdapter
}

export class ProxyOptions extends Context.Tag("ProxyOptions")<
  ProxyOptions,
  ProxyConfig
>() {}

interface DeployPayload {
  readonly checksum: string
  readonly ir: unknown
  readonly meta?: unknown
}

export interface ProxyStatus {
  readonly upstream: "ok" | "down" | "unknown"
  readonly backlog: number
  readonly lastError: string | null
}

/**
 * The store-and-forward core. Every ingested batch is (1) journaled to disk,
 * (2) applied to the embedded usage engine immediately — so entitlement and
 * enforcement checks are answered locally with zero upstream round trips —
 * and (3) forwarded to the parent asynchronously, surviving upstream
 * outages and proxy restarts.
 */
export class ProxySync extends Effect.Service<ProxySync>()("ProxySync", {
  effect: Effect.gen(function* () {
    const options = yield* ProxyOptions
    const configs = yield* ConfigStore
    const engine = yield* UsageEngine
    const store = options.persistence ?? filePersistence(options.dataDir ?? ".void-proxy")
    const backlogNow = Effect.promise(async () => {
      const [batches, cursor] = await Promise.all([store.allBatches(), store.cursor()])
      return batches.length - cursor
    })
    const upstreamState = yield* Ref.make<"ok" | "down" | "unknown">("unknown")
    const lastError = yield* Ref.make<string | null>(null)
    // Flushes must not interleave: two concurrent flushes would both read
    // the cursor before either advances it and double-forward the backlog.
    // (Delivery is still at-least-once across crashes — a real upstream
    // would dedupe on an idempotency key.)
    const flushLock = yield* Effect.makeSemaphore(1)

    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(options.token !== undefined
        ? { authorization: `Bearer ${options.token}` }
        : {})
    }

    const upstreamRequest = (path: string, init?: RequestInit) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(`${options.upstream}${path}`, {
            ...init,
            headers
          })
          const body = (await response.json().catch(() => ({}))) as unknown
          if (!response.ok) {
            throw new Error(
              typeof body === "object" && body !== null && "error" in body
                ? String((body as { error: unknown }).error)
                : `upstream responded ${response.status}`
            )
          }
          return body
        },
        catch: (cause) => new Error(String(cause instanceof Error ? cause.message : cause))
      })

    const markUpstream = (ok: boolean, error?: string) =>
      Ref.set(upstreamState, ok ? "ok" : "down").pipe(
        Effect.zipRight(Ref.set(lastError, ok ? null : (error ?? "unreachable")))
      )

    /** Apply a config locally (idempotent via checksum) and cache it on disk. */
    const applyConfig = (payload: DeployPayload) =>
      Effect.gen(function* () {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const outcome = yield* configs.deploy(payload as any)
        if (outcome.status === "accepted") {
          yield* engine.notify
          yield* Effect.promise(() => store.saveConfig(payload))
        }
        return outcome
      })

    /** Pull the active config from the parent; keep the cached one if down. */
    const pullConfig = Effect.gen(function* () {
      const body = yield* upstreamRequest("/v1/config")
      yield* markUpstream(true)
      const active = (body as { active: { checksum: string; ir: unknown } | null }).active
      if (active === null) return
      yield* applyConfig({ checksum: active.checksum, ir: active.ir }).pipe(
        Effect.catchAll(() => Effect.void)
      )
    }).pipe(
      Effect.catchAll((error) => markUpstream(false, error.message))
    )

    /** Forward journaled-but-unacknowledged batches upstream, in order. */
    const flush: Effect.Effect<void> = flushLock.withPermits(1)(
      Effect.gen(function* () {
        const batches = yield* Effect.promise(() => store.allBatches())
        const cursor = yield* Effect.promise(() => store.cursor())
        for (const batch of batches.slice(cursor)) {
          yield* upstreamRequest("/v1/events", {
            method: "POST",
            body: JSON.stringify({ events: batch })
          })
          yield* Effect.promise(() => store.advanceCursor())
        }
        yield* markUpstream(true)
      }).pipe(Effect.catchAll((error) => markUpstream(false, error.message)))
    )

    /**
     * Journal + apply locally + kick off forwarding. The local summary is
     * the response — the app gets instant metering regardless of upstream.
     * Events are stamped with a timestamp so journal replay is faithful.
     */
    const ingest = (
      events: ReadonlyArray<IngestEvent>
    ): Effect.Effect<IngestSummary & { proxied: true; backlog: number }, NoActiveConfig> =>
      Effect.gen(function* () {
        const now = new Date().toISOString()
        const stamped = events.map((event) =>
          event.timestamp !== undefined ? event : { ...event, timestamp: now }
        )
        const summary = yield* engine.ingest(stamped)
        yield* Effect.promise(() => store.appendBatch(stamped))
        yield* Effect.forkDaemon(flush)
        return { ...summary, proxied: true as const, backlog: yield* backlogNow }
      })

    /** Restart recovery: cached config first, then rebuild state from the journal. */
    const boot = Effect.gen(function* () {
      const cached = yield* Effect.promise(() => store.loadConfig())
      if (cached !== null) {
        yield* applyConfig(cached as DeployPayload).pipe(
          Effect.catchAll(() => Effect.void)
        )
      }
      yield* pullConfig
      for (const batch of yield* Effect.promise(() => store.allBatches())) {
        yield* engine.ingest(batch as ReadonlyArray<IngestEvent>).pipe(
          Effect.catchAll(() => Effect.void)
        )
      }
    })

    const status: Effect.Effect<ProxyStatus> = Effect.gen(function* () {
      return {
        upstream: yield* Ref.get(upstreamState),
        backlog: yield* backlogNow,
        lastError: yield* Ref.get(lastError)
      }
    })

    /** Forward a deploy to the parent (source of truth), then mirror locally. */
    const deploy = (payload: DeployPayload) =>
      Effect.gen(function* () {
        const upstream = yield* upstreamRequest("/v1/deploy", {
          method: "POST",
          body: JSON.stringify(payload)
        })
        yield* markUpstream(true)
        yield* applyConfig(payload).pipe(Effect.catchAll(() => Effect.void))
        return upstream
      }).pipe(
        Effect.tapError((error) => markUpstream(false, error.message))
      )

    return { boot, ingest, flush, pullConfig, status, deploy } as const
  })
}) {}

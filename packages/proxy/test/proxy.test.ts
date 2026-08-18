import { HttpClient, HttpClientRequest, HttpServer } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { compile } from "@void/compiler"
import { UsageEngine } from "@void/server"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProxyLive, proxyRouter } from "../src/Http.js"
import { memoryPersistence, teePersistence } from "../src/Persistence.js"
import { ProxySync } from "../src/Sync.js"

const source = `
  meter api_calls {
    filter event.name == "api.request"
    aggregate count
  }
  product pro {
    name "Pro"
    price recurring monthly 29 USD
    meter api_calls { per_unit 100 USD_CENTS }
  }
  invariant "hard stop" { spend(customer) <= 30 USD else block }
`
const { ir } = Effect.runSync(compile(source))
const checksum = `sha256:${createHash("sha256").update(JSON.stringify(ir)).digest("hex")}`

/** A parent void server with a toggleable outage switch. */
const startUpstream = async () => {
  const received: Array<ReadonlyArray<unknown>> = []
  const deploys: Array<unknown> = []
  let up = true
  const server = createServer((req, res) => {
    const chunks: Array<Buffer> = []
    req.on("data", (chunk) => chunks.push(chunk as Buffer))
    req.on("end", () => {
      res.setHeader("content-type", "application/json")
      if (!up) {
        res.statusCode = 503
        res.end(JSON.stringify({ error: "upstream down" }))
        return
      }
      const raw = Buffer.concat(chunks).toString()
      const body = raw.length > 0 ? (JSON.parse(raw) as { events?: unknown[] }) : {}
      if (req.url === "/v1/config") {
        res.end(
          JSON.stringify({
            active: {
              version: 1,
              checksum,
              deployed_at: "2026-08-17T00:00:00.000Z",
              source: null,
              meters: ir.meters.length,
              products: ir.products.length,
              processor: null,
              ir
            }
          })
        )
        return
      }
      if (req.url === "/v1/events") {
        received.push(body.events as ReadonlyArray<unknown>)
        res.statusCode = 202
        res.end(JSON.stringify({ ingested: 1, matched: {}, reversed: {}, cost_minor: 0 }))
        return
      }
      if (req.url === "/v1/deploy") {
        deploys.push(body)
        res.statusCode = 201
        res.end(JSON.stringify({ status: "accepted", version: 2 }))
        return
      }
      res.statusCode = 404
      res.end("{}")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    deploys,
    setUp(value: boolean) {
      up = value
    },
    close: () => server.close()
  }
}

const freshDataDir = () => mkdtempSync(join(tmpdir(), "void-proxy-"))

it.effect("serves local reads, forwards events, and survives an upstream outage", () =>
  Effect.gen(function* () {
    const upstream = yield* Effect.promise(startUpstream)
    const dataDir = freshDataDir()

    yield* Effect.gen(function* () {
      const sync = yield* ProxySync
      yield* sync.boot
      yield* HttpServer.serveEffect(proxyRouter)
      const client = yield* HttpClient.HttpClient

      const post = (url: string, body: unknown) =>
        client
          .execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUnsafeJson(body)))
          .pipe(
            Effect.flatMap((r) => Effect.map(r.json, (json) => ({ status: r.status, json }))),
            Effect.scoped
          )
      const get = (url: string) =>
        client.get(url).pipe(
          Effect.flatMap((r) => Effect.map(r.json, (json) => json)),
          Effect.scoped
        )

      // Booted from the upstream config: local reads work immediately.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = (yield* get("/v1/config")) as any
      expect(config.active.version).toBe(1)

      // Ingest is answered locally (202 + local summary) and forwarded.
      const first = yield* post("/v1/events", {
        events: [{ name: "api.request", external_customer_id: "acme" }]
      })
      expect(first.status).toBe(202)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((first.json as any).matched).toEqual({ api_calls: 1 })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((first.json as any).proxied).toBe(true)
      yield* post("/v1/sync", {})
      expect(upstream.received).toHaveLength(1)

      // Upstream goes down: metering and enforcement keep working locally.
      upstream.setUp(false)
      const second = yield* post("/v1/events", {
        events: [
          { name: "api.request", external_customer_id: "acme" },
          { name: "api.request", external_customer_id: "acme" }
        ]
      })
      expect(second.status).toBe(202)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const health = (yield* get("/health")) as any
      expect(health.upstream).toBe("down")
      expect(health.backlog).toBeGreaterThanOrEqual(1)

      // $29 base + 3 calls at $1 = $32 > $30 cap -> blocked, judged locally.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entitlements = (yield* get("/v1/entitlements/acme")) as any
      expect(entitlements.enforcement).toBe("blocked")

      // Upstream recovers: sync drains the backlog in order.
      upstream.setUp(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const drained = (yield* post("/v1/sync", {})).json as any
      expect(drained.backlog).toBe(0)
      expect(upstream.received).toHaveLength(2)

      // Deploys pass through to the parent and mirror locally.
      const deployed = yield* post("/v1/deploy", { checksum, ir })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((deployed.json as any).status).toBe("accepted")
      expect(upstream.deploys).toHaveLength(1)
    }).pipe(
      Effect.scoped,
      Effect.provide(ProxyLive({ upstream: upstream.url, dataDir })),
      Effect.provide(NodeHttpServer.layerTest)
    )

    upstream.close()
  })
)

it.effect("recovers state from the journal and cached config after a restart", () =>
  Effect.gen(function* () {
    const upstream = yield* Effect.promise(startUpstream)
    const dataDir = freshDataDir()

    // First life: boot from upstream, meter some usage, forward it.
    yield* Effect.gen(function* () {
      const sync = yield* ProxySync
      yield* sync.boot
      yield* sync.ingest([
        { name: "api.request", external_customer_id: "acme", properties: {} },
        { name: "api.request", external_customer_id: "acme", properties: {} }
      ])
      yield* sync.flush
    }).pipe(Effect.provide(ProxyLive({ upstream: upstream.url, dataDir })))
    expect(upstream.received.flat()).toHaveLength(2)

    // The upstream dies, the proxy restarts: cached config + journal replay
    // must reproduce local state with zero upstream contact.
    upstream.setUp(false)
    yield* Effect.gen(function* () {
      const sync = yield* ProxySync
      yield* sync.boot
      const engine = yield* UsageEngine
      const usage = yield* engine.usage
      expect(usage).toEqual([
        { meter: "api_calls", customer: "acme", aggregation: "count", value: 2 }
      ])
      const status = yield* sync.status
      expect(status.upstream).toBe("down")
    }).pipe(Effect.provide(ProxyLive({ upstream: upstream.url, dataDir })))

    upstream.close()
  })
)

it.effect("supports pluggable persistence with dual writes", () =>
  Effect.gen(function* () {
    const upstream = yield* Effect.promise(startUpstream)
    const primary = memoryPersistence()
    const audit = memoryPersistence()

    yield* Effect.gen(function* () {
      const sync = yield* ProxySync
      yield* sync.boot
      yield* sync.ingest([
        { name: "api.request", external_customer_id: "acme", properties: {} }
      ])
      yield* sync.flush
    }).pipe(
      Effect.provide(
        ProxyLive({
          upstream: upstream.url,
          persistence: teePersistence(primary, audit)
        })
      )
    )

    // Both stores saw the batch and the cached config — the audit copy
    // lives wherever the secondary adapter points (e.g. your warehouse).
    expect(yield* Effect.promise(() => primary.allBatches())).toHaveLength(1)
    expect(yield* Effect.promise(() => audit.allBatches())).toHaveLength(1)
    expect(yield* Effect.promise(() => audit.loadConfig())).not.toBeNull()
    // forwarded and acknowledged
    expect(yield* Effect.promise(() => primary.cursor())).toBe(1)
    upstream.close()
  })
)

it.effect("refuses deploys when the upstream is unreachable", () =>
  Effect.gen(function* () {
    const upstream = yield* Effect.promise(startUpstream)
    upstream.setUp(false)
    const dataDir = freshDataDir()
    yield* Effect.gen(function* () {
      yield* HttpServer.serveEffect(proxyRouter)
      const client = yield* HttpClient.HttpClient
      const response = yield* client
        .execute(
          HttpClientRequest.post("/v1/deploy").pipe(
            HttpClientRequest.bodyUnsafeJson({ checksum, ir })
          )
        )
        .pipe(
          Effect.flatMap((r) => Effect.map(r.json, (json) => ({ status: r.status, json }))),
          Effect.scoped
        )
      expect(response.status).toBe(502)
    }).pipe(
      Effect.scoped,
      Effect.provide(ProxyLive({ upstream: upstream.url, dataDir })),
      Effect.provide(NodeHttpServer.layerTest)
    )
    upstream.close()
  })
)

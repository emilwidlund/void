import { HttpMiddleware, HttpServer } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { createServer } from "node:http"
import { ProxyLive, proxyRouter } from "./Http.js"
import { ProxySync } from "./Sync.js"

const upstream = process.env["VOID_UPSTREAM"]
if (upstream === undefined) {
  console.error("VOID_UPSTREAM is required (parent void server base URL)")
  process.exit(1)
}

const options = {
  upstream,
  ...(process.env["VOID_TOKEN"] !== undefined
    ? { token: process.env["VOID_TOKEN"] }
    : {}),
  dataDir: process.env["VOID_PROXY_DATA"] ?? ".void-proxy"
}

const port = Number(process.env["PORT"] ?? 4010)
const flushIntervalMs = Number(process.env["VOID_SYNC_INTERVAL_MS"] ?? 5000)

/** Boot (cached config + journal replay), then keep flushing and refreshing. */
const daemon = Layer.effectDiscard(
  Effect.gen(function* () {
    const sync = yield* ProxySync
    yield* sync.boot
    yield* Effect.forkDaemon(
      Effect.forever(
        sync.flush.pipe(
          Effect.zipRight(sync.pullConfig),
          Effect.delay(`${flushIntervalMs} millis`)
        )
      )
    )
  })
)

const app = proxyRouter.pipe(
  HttpServer.serve(HttpMiddleware.logger),
  HttpServer.withLogAddress
)

// One shared ProxyLive: the HTTP handlers and the sync daemon must see the
// same engine, config store and journal.
const MainLive = Layer.merge(app, daemon).pipe(
  Layer.provide(ProxyLive(options)),
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port }))
)

NodeRuntime.runMain(Layer.launch(MainLive))

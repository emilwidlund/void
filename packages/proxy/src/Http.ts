import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse
} from "@effect/platform"
import {
  configHandler,
  entitlementsHandler,
  IngestRequestSchema,
  ServicesLive,
  streamHandler,
  usageHandler
} from "@void/server"
import { Effect, Layer } from "effect"
import type { ProxyConfig } from "./Sync.js"
import { ProxyOptions, ProxySync } from "./Sync.js"

const badRequest = (error: { readonly message: string }) =>
  HttpServerResponse.json({ error: error.message }, { status: 400 })

/**
 * The merchant-side proxy router. Reads (entitlements, usage, config, the
 * SSE stream) are served straight from the embedded engine — instant and
 * outage-tolerant. Writes go through the store-and-forward core.
 */
const eventsHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.schemaBodyJson(IngestRequestSchema)
  const sync = yield* ProxySync
  const summary = yield* sync.ingest(request.events)
  return yield* HttpServerResponse.json(summary, { status: 202 })
}).pipe(
  Effect.catchTags({
    NoActiveConfig: () =>
      HttpServerResponse.json(
        { error: "no billing configuration — deploy upstream or via the proxy" },
        { status: 409 }
      ),
    ParseError: badRequest,
    RequestError: badRequest
  })
)

const deployHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const payload = yield* request.json
  const sync = yield* ProxySync
  // The parent is the source of truth: forward first, mirror locally after.
  const outcome = yield* sync.deploy(payload as { checksum: string; ir: unknown })
  return yield* HttpServerResponse.json(outcome)
}).pipe(
  Effect.catchAll((error) =>
    HttpServerResponse.json(
      { error: `deploy not applied — upstream unreachable (${String((error as { message?: string }).message ?? error)})` },
      { status: 502 }
    )
  )
)

const healthHandler = Effect.gen(function* () {
  const sync = yield* ProxySync
  const status = yield* sync.status
  return yield* HttpServerResponse.json({ status: "ok", ...status })
})

const syncHandler = Effect.gen(function* () {
  const sync = yield* ProxySync
  yield* sync.flush
  yield* sync.pullConfig
  const status = yield* sync.status
  return yield* HttpServerResponse.json(status)
})

export const proxyRouter = HttpRouter.empty.pipe(
  HttpRouter.get("/health", healthHandler),
  HttpRouter.post("/v1/events", eventsHandler),
  HttpRouter.post("/v1/deploy", deployHandler),
  HttpRouter.post("/v1/sync", syncHandler),
  HttpRouter.get("/v1/usage", usageHandler),
  HttpRouter.get("/v1/entitlements/:customer", entitlementsHandler),
  HttpRouter.get("/v1/config", configHandler),
  HttpRouter.get("/v1/stream", streamHandler)
)

/** Everything below the HTTP layer, for embedding and tests. */
export const ProxyLive = (options: ProxyConfig) =>
  ProxySync.Default.pipe(
    Layer.provideMerge(ServicesLive),
    Layer.provideMerge(Layer.succeed(ProxyOptions, options))
  )

export const ProxyAppLive = (options: ProxyConfig) =>
  proxyRouter.pipe(
    HttpServer.serve(HttpMiddleware.logger),
    HttpServer.withLogAddress,
    Layer.provide(ProxyLive(options))
  )

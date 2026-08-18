import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse
} from "@effect/platform"
import { Effect, Layer, Stream } from "effect"
import { ConfigStore, describeActive } from "./ConfigStore.js"
import { DeployPayloadSchema, IngestRequestSchema } from "./Domain.js"
import { UsageEngine } from "./UsageEngine.js"

const badRequest = (error: { readonly message: string }) =>
  HttpServerResponse.json({ error: error.message }, { status: 400 })

export const deployHandler = Effect.gen(function* () {
  const payload = yield* HttpServerRequest.schemaBodyJson(DeployPayloadSchema)
  const store = yield* ConfigStore
  const outcome = yield* store.deploy(payload)
  if (outcome.status === "accepted") {
    const engine = yield* UsageEngine
    yield* engine.notify
  }
  return yield* HttpServerResponse.json(outcome, {
    status: outcome.status === "accepted" ? 201 : 200
  })
}).pipe(
  Effect.catchTags({
    ChecksumMismatch: (e) =>
      HttpServerResponse.json(
        { error: "checksum mismatch", expected: e.expected, received: e.received },
        { status: 400 }
      ),
    ParseError: badRequest,
    RequestError: badRequest
  })
)

export const ingestHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.schemaBodyJson(IngestRequestSchema)
  const engine = yield* UsageEngine
  const summary = yield* engine.ingest(request.events)
  return yield* HttpServerResponse.json(summary, { status: 202 })
}).pipe(
  Effect.catchTags({
    NoActiveConfig: () =>
      HttpServerResponse.json(
        { error: "no billing configuration deployed — deploy one first" },
        { status: 409 }
      ),
    ParseError: badRequest,
    RequestError: badRequest
  })
)

export const usageHandler = Effect.gen(function* () {
  const engine = yield* UsageEngine
  const rows = yield* engine.usage
  const costs = yield* engine.costs
  const meterCosts = yield* engine.meterCosts
  return yield* HttpServerResponse.json({ usage: rows, costs, meter_costs: meterCosts })
})

export const entitlementsHandler = Effect.gen(function* () {
  const params = yield* HttpRouter.params
  const customer = params.customer
  if (customer === undefined || customer.length === 0) {
    return yield* HttpServerResponse.json({ error: "missing customer" }, { status: 400 })
  }
  const engine = yield* UsageEngine
  const resolved = yield* engine.entitlements(customer)
  return yield* HttpServerResponse.json(resolved)
}).pipe(
  Effect.catchTag("NoActiveConfig", () =>
    HttpServerResponse.json(
      { error: "no billing configuration deployed — deploy one first" },
      { status: 409 }
    )
  )
)

export const configHandler = Effect.gen(function* () {
  const store = yield* ConfigStore
  const active = yield* store.active
  return yield* HttpServerResponse.json({ active: describeActive(active) })
})

const encoder = new TextEncoder()

/** Server-sent events: a full snapshot on connect, then one per change. */
export const streamHandler = Effect.gen(function* () {
  const engine = yield* UsageEngine
  const events = engine.changes.pipe(
    Stream.map((snapshot) => `data: ${JSON.stringify(snapshot)}\n\n`)
  )
  const keepAlive = Stream.tick("15 seconds").pipe(Stream.map(() => ": keep-alive\n\n"))
  return HttpServerResponse.stream(
    Stream.merge(events, keepAlive).pipe(Stream.map((chunk) => encoder.encode(chunk))),
    {
      contentType: "text/event-stream",
      headers: {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive"
      }
    }
  )
})

export const router = HttpRouter.empty.pipe(
  HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
  HttpRouter.post("/v1/deploy", deployHandler),
  HttpRouter.post("/v1/events", ingestHandler),
  HttpRouter.get("/v1/usage", usageHandler),
  HttpRouter.get("/v1/entitlements/:customer", entitlementsHandler),
  HttpRouter.get("/v1/config", configHandler),
  HttpRouter.get("/v1/stream", streamHandler)
)

export const ServicesLive = Layer.provideMerge(UsageEngine.Default, ConfigStore.Default)

export const AppLive = router.pipe(
  HttpServer.serve(HttpMiddleware.logger),
  HttpServer.withLogAddress,
  Layer.provide(ServicesLive)
)

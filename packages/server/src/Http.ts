import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse
} from "@effect/platform"
import { Effect, Layer } from "effect"
import { ConfigStore } from "./ConfigStore.js"
import { DeployPayloadSchema, IngestRequestSchema } from "./Domain.js"
import { UsageEngine } from "./UsageEngine.js"

const badRequest = (error: { readonly message: string }) =>
  HttpServerResponse.json({ error: error.message }, { status: 400 })

const deployHandler = Effect.gen(function* () {
  const payload = yield* HttpServerRequest.schemaBodyJson(DeployPayloadSchema)
  const store = yield* ConfigStore
  const outcome = yield* store.deploy(payload)
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

const ingestHandler = Effect.gen(function* () {
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

const usageHandler = Effect.gen(function* () {
  const engine = yield* UsageEngine
  const rows = yield* engine.usage
  return yield* HttpServerResponse.json({ usage: rows })
})

const configHandler = Effect.gen(function* () {
  const store = yield* ConfigStore
  const active = yield* store.active
  if (active === undefined) {
    return yield* HttpServerResponse.json({ active: null })
  }
  return yield* HttpServerResponse.json({
    active: {
      version: active.version,
      checksum: active.checksum,
      deployed_at: active.deployedAt,
      source: active.source ?? null,
      meters: active.ir.meters.length,
      products: active.ir.products.length,
      ir: active.ir
    }
  })
})

export const router = HttpRouter.empty.pipe(
  HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
  HttpRouter.post("/v1/deploy", deployHandler),
  HttpRouter.post("/v1/events", ingestHandler),
  HttpRouter.get("/v1/usage", usageHandler),
  HttpRouter.get("/v1/config", configHandler)
)

export const ServicesLive = Layer.provideMerge(UsageEngine.Default, ConfigStore.Default)

export const AppLive = router.pipe(
  HttpServer.serve(HttpMiddleware.logger),
  HttpServer.withLogAddress,
  Layer.provide(ServicesLive)
)

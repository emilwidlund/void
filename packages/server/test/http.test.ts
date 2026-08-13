import { HttpClient, HttpClientRequest, HttpServer } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { compile } from "@void/compiler"
import { Effect } from "effect"
import { checksumIr } from "../src/ConfigStore.js"
import { router, ServicesLive } from "../src/Http.js"

const source = `
  meter api_calls {
    filter event.name == "api.request"
    aggregate count
  }
  meter compute_seconds {
    filter event.name == "compute.done" and event.status == "success"
    aggregate sum(event.duration_s)
  }
  product pro {
    name "Pro Plan"
    price recurring monthly 29 USD
    meter api_calls {
      per_unit 10 USD_CENTS
      included 10_000
    }
  }
`

interface JsonResponse {
  readonly status: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly json: any
}

it.effect("deploy → ingest → usage flow", () =>
  Effect.gen(function* () {
    yield* HttpServer.serveEffect(router)
    const client = yield* HttpClient.HttpClient

    const post = (url: string, body: unknown): Effect.Effect<JsonResponse, unknown> =>
      client
        .execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUnsafeJson(body)))
        .pipe(
          Effect.flatMap((r) => Effect.map(r.json, (json) => ({ status: r.status, json }))),
          Effect.scoped
        )

    const get = (url: string): Effect.Effect<JsonResponse, unknown> =>
      client.get(url).pipe(
        Effect.flatMap((r) => Effect.map(r.json, (json) => ({ status: r.status, json }))),
        Effect.scoped
      )

    // Nothing deployed yet
    const empty = yield* get("/v1/config")
    expect(empty.json).toEqual({ active: null })
    const rejected = yield* post("/v1/events", { events: [{ name: "api.request" }] })
    expect(rejected.status).toBe(409)

    // Deploy a compiled config
    const { ir } = yield* compile(source)
    const payload = { checksum: checksumIr(ir), ir, meta: { source: "test.void" } }
    const deployed = yield* post("/v1/deploy", payload)
    expect(deployed.status).toBe(201)
    expect(deployed.json).toEqual({ status: "accepted", version: 1 })

    // Same checksum is a no-op; tampered checksum is rejected
    const again = yield* post("/v1/deploy", payload)
    expect(again.json).toEqual({ status: "unchanged", version: 1 })
    const tampered = yield* post("/v1/deploy", { ...payload, checksum: "sha256:0000" })
    expect(tampered.status).toBe(400)
    expect(tampered.json.error).toBe("checksum mismatch")

    const config = yield* get("/v1/config")
    expect(config.json.active).toMatchObject({ version: 1, meters: 2, products: 1 })

    // Ingest a batch of events
    const ingested = yield* post("/v1/events", {
      events: [
        { name: "api.request", external_customer_id: "acme" },
        { name: "api.request", external_customer_id: "acme" },
        { name: "api.request", external_customer_id: "globex" },
        { name: "api.request" },
        { name: "compute.done", external_customer_id: "acme", properties: { status: "success", duration_s: 12.5 } },
        { name: "compute.done", external_customer_id: "acme", properties: { status: "success", duration_s: 7.5 } },
        { name: "compute.done", external_customer_id: "acme", properties: { status: "failed", duration_s: 100 } },
        { name: "unrelated.event" }
      ]
    })
    expect(ingested.status).toBe(202)
    expect(ingested.json).toEqual({
      ingested: 8,
      matched: { api_calls: 4, compute_seconds: 2 }
    })

    // Aggregated usage per meter and customer
    const usage = yield* get("/v1/usage")
    expect(usage.json.usage).toEqual([
      { meter: "api_calls", customer: "acme", aggregation: "count", value: 2 },
      { meter: "api_calls", customer: "anonymous", aggregation: "count", value: 1 },
      { meter: "api_calls", customer: "globex", aggregation: "count", value: 1 },
      { meter: "compute_seconds", customer: "acme", aggregation: "sum", value: 20 }
    ])

    // Usage accumulates across batches
    yield* post("/v1/events", {
      events: [{ name: "api.request", external_customer_id: "acme" }]
    })
    const accumulated = yield* get("/v1/usage")
    expect(accumulated.json.usage[0]).toMatchObject({ customer: "acme", value: 3 })

    // Malformed bodies are rejected
    const malformed = yield* post("/v1/events", { events: [] })
    expect(malformed.status).toBe(400)
  }).pipe(
    Effect.scoped,
    Effect.provide(ServicesLive),
    Effect.provide(NodeHttpServer.layerTest)
  )
)

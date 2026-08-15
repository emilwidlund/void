import { HttpClient, HttpClientRequest, HttpServer } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { compile } from "@void/compiler"
import { Effect, Fiber, Stream } from "effect"
import { checksumIr } from "../src/ConfigStore.js"
import { router, ServicesLive } from "../src/Http.js"
import type { Snapshot } from "../src/UsageEngine.js"

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
    entitlement sso
    entitlement seats { limit 5 }
    entitlement api_quota {
      meter api_calls
      limit 3
    }
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

    // Ingest a batch of events (some carrying `_cost` in major units)
    const ingested = yield* post("/v1/events", {
      events: [
        { name: "api.request", external_customer_id: "acme", _cost: { amount: 0.004, currency: "USD" } },
        { name: "api.request", external_customer_id: "acme" },
        { name: "api.request", external_customer_id: "globex" },
        { name: "api.request" },
        { name: "compute.done", external_customer_id: "acme", properties: { status: "success", duration_s: 12.5 }, _cost: { amount: 0.01, currency: "USD" } },
        { name: "compute.done", external_customer_id: "acme", properties: { status: "success", duration_s: 7.5 }, _cost: { amount: 0.01, currency: "USD" } },
        { name: "compute.done", external_customer_id: "acme", properties: { status: "failed", duration_s: 100 } },
        { name: "unrelated.event" }
      ]
    })
    expect(ingested.status).toBe(202)
    expect(ingested.json).toEqual({
      ingested: 8,
      matched: { api_calls: 4, compute_seconds: 2 },
      reversed: {},
      cost_minor: 2.4
    })

    // Aggregated usage per meter and customer, plus accumulated costs
    const usage = yield* get("/v1/usage")
    expect(usage.json.usage).toEqual([
      { meter: "api_calls", customer: "acme", aggregation: "count", value: 2 },
      { meter: "api_calls", customer: "anonymous", aggregation: "count", value: 1 },
      { meter: "api_calls", customer: "globex", aggregation: "count", value: 1 },
      { meter: "compute_seconds", customer: "acme", aggregation: "sum", value: 20 }
    ])
    expect(usage.json.costs).toEqual([
      { customer: "acme", event: "api.request", currency: "USD", cost_minor: 0.4 },
      { customer: "acme", event: "compute.done", currency: "USD", cost_minor: 2 }
    ])
    // Costs are also attributed to every meter whose filter matched the event
    expect(usage.json.meter_costs).toEqual([
      { meter: "api_calls", customer: "acme", currency: "USD", cost_minor: 0.4 },
      { meter: "compute_seconds", customer: "acme", currency: "USD", cost_minor: 2 }
    ])

    // Negative amounts and malformed currencies are rejected by the schema
    const negative = yield* post("/v1/events", {
      events: [{ name: "api.request", _cost: { amount: -1, currency: "USD" } }]
    })
    expect(negative.status).toBe(400)
    const badCurrency = yield* post("/v1/events", {
      events: [{ name: "api.request", _cost: { amount: 1, currency: "dollars" } }]
    })
    expect(badCurrency.status).toBe(400)

    // Entitlements resolve against attributed products and live usage
    const within = yield* get("/v1/entitlements/acme")
    expect(within.status).toBe(200)
    expect(within.json).toEqual({
      customer: "acme",
      products: ["pro"],
      entitlements: [
        { id: "sso", product: "pro", type: "flag" },
        { id: "seats", product: "pro", type: "limit", limit: 5 },
        {
          id: "api_quota",
          product: "pro",
          type: "metered",
          meter: "api_calls",
          limit: 3,
          used: 2,
          remaining: 1,
          exceeded: false
        }
      ],
      enforcement: "ok",
      violations: []
    })

    // A customer with no usage has no attributed products
    const unknown = yield* get("/v1/entitlements/nobody")
    expect(unknown.json).toEqual({
      customer: "nobody",
      products: [],
      entitlements: [],
      enforcement: "ok",
      violations: []
    })

    // Usage accumulates across batches
    yield* post("/v1/events", {
      events: [{ name: "api.request", external_customer_id: "acme" }]
    })
    const accumulated = yield* get("/v1/usage")
    expect(accumulated.json.usage[0]).toMatchObject({ customer: "acme", value: 3 })

    // The metered entitlement flips to exceeded once usage passes the limit
    yield* post("/v1/events", {
      events: [
        { name: "api.request", external_customer_id: "acme" },
        { name: "api.request", external_customer_id: "acme" }
      ]
    })
    const exceeded = yield* get("/v1/entitlements/acme")
    expect(exceeded.json.entitlements[2]).toMatchObject({
      id: "api_quota",
      used: 5,
      remaining: 0,
      exceeded: true
    })

    // Malformed bodies are rejected
    const malformed = yield* post("/v1/events", { events: [] })
    expect(malformed.status).toBe(400)
  }).pipe(
    Effect.scoped,
    Effect.provide(ServicesLive),
    Effect.provide(NodeHttpServer.layerTest)
  )
)

it.effect("reversal events unwind prior charges within the window", () =>
  Effect.gen(function* () {
    yield* HttpServer.serveEffect(router)
    const client = yield* HttpClient.HttpClient
    const post = (url: string, body: unknown) =>
      client
        .execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUnsafeJson(body)))
        .pipe(
          Effect.flatMap((r) => Effect.map(r.json, (json) => json)),
          Effect.scoped
        )
    const get = (url: string) =>
      client.get(url).pipe(
        Effect.flatMap((r) => Effect.map(r.json, (json) => json)),
        Effect.scoped
      )

    const { ir } = yield* compile(`
      meter tickets {
        filter event.name == "ticket.closed" and event.resolution == "solved"
        aggregate count
        reverse_on event.name == "ticket.reopened" within 7 days
      }
      product agent {
        name "Agent"
        meter tickets { per_unit 2 USD }
      }
    `)
    yield* post("/v1/deploy", { checksum: checksumIr(ir), ir })

    // Three resolved tickets, one of them long ago (outside the 7-day window)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const charged = (yield* post("/v1/events", {
      events: [
        { name: "ticket.closed", external_customer_id: "acme", timestamp: "2026-08-01T00:00:00Z", properties: { resolution: "solved" } },
        { name: "ticket.closed", external_customer_id: "acme", timestamp: "2026-08-14T10:00:00Z", properties: { resolution: "solved" } },
        { name: "ticket.closed", external_customer_id: "acme", timestamp: "2026-08-14T11:00:00Z", properties: { resolution: "solved" } },
        { name: "ticket.closed", external_customer_id: "acme", timestamp: "2026-08-14T11:30:00Z", properties: { resolution: "unresolved" } }
      ]
    })) as any
    expect(charged.matched).toEqual({ tickets: 3 })

    // A reopen unwinds the most recent in-window charge
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reversed = (yield* post("/v1/events", {
      events: [
        { name: "ticket.reopened", external_customer_id: "acme", timestamp: "2026-08-14T12:00:00Z" }
      ]
    })) as any
    expect(reversed.reversed).toEqual({ tickets: 1 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usage = (yield* get("/v1/usage")) as any
    expect(usage.usage).toEqual([
      { meter: "tickets", customer: "acme", aggregation: "count", value: 2 }
    ])

    // Only the 2026-08-01 charge remains in range history-wise, but it's
    // outside the reopen window: further reopens can only unwind the one
    // remaining in-window charge, then stop at the floor.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const more = (yield* post("/v1/events", {
      events: [
        { name: "ticket.reopened", external_customer_id: "acme", timestamp: "2026-08-14T13:00:00Z" },
        { name: "ticket.reopened", external_customer_id: "acme", timestamp: "2026-08-14T14:00:00Z" }
      ]
    })) as any
    expect(more.reversed).toEqual({ tickets: 1 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after = (yield* get("/v1/usage")) as any
    expect(after.usage[0].value).toBe(1)
  }).pipe(
    Effect.scoped,
    Effect.provide(ServicesLive),
    Effect.provide(NodeHttpServer.layerTest)
  )
)

it.effect("outcome chains complete in order, correlated per instance", () =>
  Effect.gen(function* () {
    yield* HttpServer.serveEffect(router)
    const client = yield* HttpClient.HttpClient
    const post = (url: string, body: unknown) =>
      client
        .execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUnsafeJson(body)))
        .pipe(
          Effect.flatMap((r) => Effect.map(r.json, (json) => json)),
          Effect.scoped
        )
    const get = (url: string) =>
      client.get(url).pipe(
        Effect.flatMap((r) => Effect.map(r.json, (json) => json)),
        Effect.scoped
      )

    const { ir } = yield* compile(`
      outcome resolution {
        correlate event.ticket_id
        step event.name == "ticket.opened"
        step event.name == "ticket.closed" and event.resolution == "solved"
        fail_on event.name == "ticket.reopened" within 7 days
      }
      product agent {
        name "Agent"
        outcome resolution { per_unit 2 USD }
      }
    `)
    yield* post("/v1/deploy", { checksum: checksumIr(ir), ir })

    const at = (h: number) => `2026-08-14T${String(h).padStart(2, "0")}:00:00Z`
    // Two interleaved tickets; a close without a prior open does nothing;
    // an unresolved close does not complete the chain.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = (yield* post("/v1/events", {
      events: [
        { name: "ticket.opened", external_customer_id: "acme", timestamp: at(1), properties: { ticket_id: "A" } },
        { name: "ticket.opened", external_customer_id: "acme", timestamp: at(2), properties: { ticket_id: "B" } },
        { name: "ticket.closed", external_customer_id: "acme", timestamp: at(3), properties: { ticket_id: "C", resolution: "solved" } },
        { name: "ticket.closed", external_customer_id: "acme", timestamp: at(4), properties: { ticket_id: "A", resolution: "solved" } },
        { name: "ticket.closed", external_customer_id: "acme", timestamp: at(5), properties: { ticket_id: "B", resolution: "unresolved" } }
      ]
    })) as any
    // only ticket A completed the full chain
    expect(first.matched).toEqual({ resolution: 1 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usage = (yield* get("/v1/usage")) as any
    expect(usage.usage).toEqual([
      { meter: "resolution", customer: "acme", aggregation: "count", value: 1 }
    ])

    // Reopening B (never completed) reverses nothing; reopening A reverses A.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reopen = (yield* post("/v1/events", {
      events: [
        { name: "ticket.reopened", external_customer_id: "acme", timestamp: at(6), properties: { ticket_id: "B" } },
        { name: "ticket.reopened", external_customer_id: "acme", timestamp: at(7), properties: { ticket_id: "A" } }
      ]
    })) as any
    expect(reopen.reversed).toEqual({ resolution: 1 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after = (yield* get("/v1/usage")) as any
    expect(after.usage[0].value).toBe(0)
  }).pipe(
    Effect.scoped,
    Effect.provide(ServicesLive),
    Effect.provide(NodeHttpServer.layerTest)
  )
)

it.effect("customer overrides replace prices and entitlements", () =>
  Effect.gen(function* () {
    yield* HttpServer.serveEffect(router)
    const client = yield* HttpClient.HttpClient
    const post = (url: string, body: unknown) =>
      client
        .execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUnsafeJson(body)))
        .pipe(Effect.scoped)
    const get = (url: string) =>
      client.get(url).pipe(
        Effect.flatMap((r) => Effect.map(r.json, (json) => json)),
        Effect.scoped
      )

    const { ir } = yield* compile(`
      meter api_calls { aggregate count }
      product pro {
        name "Pro"
        price recurring monthly 29 USD
        meter api_calls { per_unit 10 USD_CENTS }
        entitlement seats { limit 5 }
      }
      invariant "hard stop" { spend(customer) <= 30 USD else block }
      override customer "acme" {
        meter api_calls { per_unit 1 USD_CENTS }
        entitlement seats { limit 20 }
        entitlement sso
      }
    `)
    yield* post("/v1/deploy", { checksum: checksumIr(ir), ir })

    const calls = Array.from({ length: 20 }, () => ({ name: "api.request" }))
    yield* post("/v1/events", {
      events: calls.map((c) => ({ ...c, external_customer_id: "acme" }))
    })
    yield* post("/v1/events", {
      events: calls.map((c) => ({ ...c, external_customer_id: "globex" }))
    })

    // globex pays list price: 2900 + 20*10 = 3100 > 3000 -> blocked.
    // acme's override prices calls at 1¢: 2900 + 20 = 2920 -> ok.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const globex = (yield* get("/v1/entitlements/globex")) as any
    expect(globex.enforcement).toBe("blocked")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acme = (yield* get("/v1/entitlements/acme")) as any
    expect(acme.enforcement).toBe("ok")
    // override entitlements replace and extend the product's
    expect(acme.entitlements).toEqual([
      { id: "seats", product: "override", type: "limit", limit: 20 },
      { id: "sso", product: "override", type: "flag" }
    ])
    expect(globex.entitlements).toEqual([
      { id: "seats", product: "pro", type: "limit", limit: 5 }
    ])
  }).pipe(
    Effect.scoped,
    Effect.provide(ServicesLive),
    Effect.provide(NodeHttpServer.layerTest)
  )
)

it.effect("blocks enforcement when a spend invariant with `else block` is violated", () =>
  Effect.gen(function* () {
    yield* HttpServer.serveEffect(router)
    const client = yield* HttpClient.HttpClient

    const post = (url: string, body: unknown) =>
      client
        .execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUnsafeJson(body)))
        .pipe(Effect.scoped)
    const get = (url: string) =>
      client.get(url).pipe(
        Effect.flatMap((r) => Effect.map(r.json, (json) => json)),
        Effect.scoped
      )

    const { ir } = yield* compile(`
      meter api_calls {
        filter event.name == "api.request"
        aggregate count
      }
      product pro {
        name "Pro"
        price recurring monthly 29 USD
        meter api_calls { per_unit 10 USD_CENTS }
      }
      invariant "hard stop" { spend(customer) <= 30 USD else block }
    `)
    yield* post("/v1/deploy", { checksum: checksumIr(ir), ir })

    // 5 calls at 10 cents + $29 base = $29.50 — inside the ceiling
    yield* post("/v1/events", {
      events: Array.from({ length: 5 }, () => ({
        name: "api.request",
        external_customer_id: "acme"
      }))
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = (yield* get("/v1/entitlements/acme")) as any
    expect(ok.enforcement).toBe("ok")
    expect(ok.violations).toEqual([])

    // 15 more calls -> $31 — over the ceiling, enforcement flips
    yield* post("/v1/events", {
      events: Array.from({ length: 15 }, () => ({
        name: "api.request",
        external_customer_id: "acme"
      }))
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocked = (yield* get("/v1/entitlements/acme")) as any
    expect(blocked.enforcement).toBe("blocked")
    expect(blocked.violations).toEqual([{ invariant: "hard stop", behavior: "block" }])
  }).pipe(
    Effect.scoped,
    Effect.provide(ServicesLive),
    Effect.provide(NodeHttpServer.layerTest)
  )
)

// Real clock (it.live) with a generous timeout: under parallel turbo runs the
// event loop can be starved, and this test waits on actual SSE delivery.
it.live("pushes snapshots over the SSE stream", () =>
  Effect.gen(function* () {
    yield* HttpServer.serveEffect(router)
    const client = yield* HttpClient.HttpClient

    const post = (url: string, body: unknown) =>
      client
        .execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUnsafeJson(body)))
        .pipe(Effect.scoped)

    const { ir } = yield* compile(source)
    yield* post("/v1/deploy", { checksum: checksumIr(ir), ir })

    const received: Array<Snapshot> = []
    const response = yield* client.get("/v1/stream")
    expect(response.headers["content-type"]).toContain("text/event-stream")

    const fiber = yield* response.stream.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.startsWith("data:")),
      Stream.map((line) => JSON.parse(line.slice("data:".length)) as Snapshot),
      Stream.take(2),
      Stream.runForEach((snapshot) => Effect.sync(() => received.push(snapshot)))
    ).pipe(Effect.fork)

    // Wait for the initial snapshot so the subscription is established
    let waited = 0
    while (received.length < 1 && waited < 400) {
      yield* Effect.sleep("20 millis")
      waited += 1
    }
    expect(received).toHaveLength(1)
    expect(received[0]!.usage).toEqual([])
    expect(received[0]!.config?.version).toBe(1)

    yield* post("/v1/events", {
      events: [{ name: "api.request", external_customer_id: "acme" }]
    })
    yield* Fiber.join(fiber)

    expect(received).toHaveLength(2)
    expect(received[1]!.usage).toEqual([
      { meter: "api_calls", customer: "acme", aggregation: "count", value: 1 }
    ])
  }).pipe(
    Effect.scoped,
    Effect.provide(ServicesLive),
    Effect.provide(NodeHttpServer.layerTest)
  ),
  20000
)

import { compile } from "@void/compiler"
import { Effect } from "effect"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, expectTypeOf, it } from "vitest"
import type { EventNameOf } from "../src/index.js"
import { defineBilling, gte, on, usd, usdCents } from "../src/index.js"

// The same Pro plan, in both frontends. The assertion that matters: they
// compile to byte-identical IR, and therefore the same deploy checksum.
const voidSource = `
meter api_calls {
  filter event.name == "api.request"
  aggregate count
  unit scalar
}

meter compute_seconds {
  filter event.name == "compute.done" and event.status == "success"
  aggregate sum(event.duration_s)
  unit minutes
}

outcome ticket_resolution {
  correlate event.ticket_id
  step event.name == "ticket.opened"
  step event.name == "ticket.closed" and event.resolution == "solved"
  fail_on event.name == "ticket.reopened" within 7 days
}

product pro {
  name "Pro Plan"
  price recurring monthly 29 USD
  entitlement sso
  entitlement seats { limit 5 }
  entitlement api_quota {
    meter api_calls
    limit 100_000
  }
  meter api_calls {
    per_unit 10 USD_CENTS
    included 10_000
  }
  meter compute_seconds { margin 60% }
  outcome ticket_resolution { per_unit 2 USD }
}

invariant "compute stays profitable" { margin(compute_seconds) >= 40% }
invariant "API price floor" { price(api_calls) >= 5 USD_CENTS else warn }
invariant "bill shock protection" { spend(customer) <= 500 USD else cap }

override customer "acme" {
  until "2027-01-01"
  meter api_calls {
    per_unit 8 USD_CENTS
    included 50_000
  }
  entitlement seats { limit 20 }
}
`

const billing = defineBilling({
  meters: {
    api_calls: {
      filter: on("api.request"),
      aggregate: "count",
      unit: "scalar"
    },
    compute_seconds: {
      filter: on("compute.done", { status: "success" }),
      aggregate: { sum: "duration_s" },
      unit: "minutes"
    },
    ticket_resolution: {
      correlate: "ticket_id",
      steps: [on("ticket.opened"), on("ticket.closed", { resolution: "solved" })],
      failOn: { on: on("ticket.reopened"), within: "7 days" }
    }
  },
  products: {
    pro: {
      name: "Pro Plan",
      price: { every: "month", amount: usd(29) },
      entitlements: {
        sso: true,
        seats: { limit: 5 },
        api_quota: { meter: "api_calls", limit: 100_000 }
      },
      usage: {
        api_calls: { perUnit: usdCents(10), included: 10_000 },
        compute_seconds: { margin: "60%" },
        ticket_resolution: { perUnit: usd(2) }
      }
    }
  },
  invariants: [
    { name: "compute stays profitable", assert: { margin: "compute_seconds", gte: "40%" } },
    { name: "API price floor", assert: { price: "api_calls", gte: usdCents(5) }, else: "warn" },
    { name: "bill shock protection", assert: { spend: "customer", lte: usd(500) }, else: "cap" }
  ],
  overrides: {
    acme: {
      until: "2027-01-01",
      usage: { api_calls: { perUnit: usdCents(8), included: 50_000 } },
      entitlements: { seats: { limit: 20 } }
    }
  }
})

describe("defineBilling", () => {
  it("compiles to byte-identical IR and checksum as the .void frontend", () => {
    const fromDsl = Effect.runSync(compile(voidSource)).ir
    expect(JSON.stringify(billing.ir)).toBe(JSON.stringify(fromDsl))
    expect(billing.checksum).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("exposes typed ids and warnings", () => {
    expect(billing.meters).toEqual(["api_calls", "compute_seconds", "ticket_resolution"])
    expect(billing.products).toEqual(["pro"])
    expect(billing.warnings).toEqual([])
  })

  it("collects every event name the config mentions", () => {
    expect([...billing.events].sort()).toEqual([
      "api.request",
      "compute.done",
      "ticket.closed",
      "ticket.opened",
      "ticket.reopened"
    ])
    // ...and at the type level, `track()` autocompletes exactly these while
    // still accepting arbitrary strings for unmetered events.
    expectTypeOf<EventNameOf<typeof billing.config>>().toEqualTypeOf<
      "api.request" | "compute.done" | "ticket.opened" | "ticket.closed" | "ticket.reopened"
    >()
    const client = billing.connect({ endpoint: "http://localhost:0" })
    type TrackName = Parameters<typeof client.track>[0]
    const known: TrackName = "ticket.opened"
    const unmetered: TrackName = "totally.unmetered" // still assignable
    expect([known, unmetered]).toHaveLength(2)
  })

  it("supports comparison matchers in filters", () => {
    const config = defineBilling({
      meters: {
        errors: {
          filter: on("api.request", { status_code: gte(500) }),
          aggregate: "count"
        }
      },
      products: { p: { name: "P", usage: { errors: { perUnit: usdCents(1) } } } }
    })
    expect(config.ir.meters[0]?.filter).toEqual({
      type: "and",
      operands: [
        { type: "comparison", property: "event.name", op: "eq", value: "api.request" },
        { type: "comparison", property: "event.status_code", op: "gte", value: 500 }
      ]
    })
  })

  it("throws when a static invariant is violated — overrides included", () => {
    expect(() =>
      defineBilling({
        meters: { api_calls: { filter: on("api.request"), aggregate: "count" } },
        products: {
          pro: { name: "Pro", usage: { api_calls: { perUnit: usdCents(10) } } }
        },
        invariants: [
          { name: "API price floor", assert: { price: "api_calls", gte: usdCents(5) } }
        ],
        overrides: {
          megacorp: { usage: { api_calls: { perUnit: usdCents(2) } } }
        }
      })
    ).toThrow(/API price floor.*override for `megacorp`/s)
  })

  it("collects warn-softened violations instead of throwing", () => {
    const soft = defineBilling({
      meters: { api_calls: { filter: on("api.request"), aggregate: "count" } },
      products: {
        cheap: { name: "Cheap", usage: { api_calls: { perUnit: usdCents(2) } } }
      },
      invariants: [
        {
          name: "API price floor",
          assert: { price: "api_calls", gte: usdCents(5) },
          else: "warn"
        }
      ]
    })
    expect(soft.warnings).toHaveLength(1)
    expect(soft.warnings[0]).toContain("API price floor")
  })

  it("rejects margin pricing on outcomes and unknown usage keys at runtime", () => {
    expect(() =>
      defineBilling({
        meters: {
          o: { correlate: "id", steps: [on("done")] }
        },
        products: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          p: { name: "P", usage: { o: { margin: "50%" } as any } }
        }
      })
    ).toThrow(/outcomes are priced perUnit/)
  })
})

describe("connect", () => {
  const withServer = async (
    handler: (path: string, body: unknown) => unknown,
    run: (endpoint: string, requests: Array<{ path: string; body: unknown }>) => Promise<void>
  ) => {
    const requests: Array<{ path: string; body: unknown }> = []
    const server = createServer((req, res) => {
      const chunks: Array<Buffer> = []
      req.on("data", (chunk) => chunks.push(chunk as Buffer))
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString()
        const body = raw.length > 0 ? JSON.parse(raw) : undefined
        requests.push({ path: req.url ?? "", body })
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify(handler(req.url ?? "", body)))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    try {
      await run(`http://127.0.0.1:${port}`, requests)
    } finally {
      server.close()
    }
  }

  it("deploys the checksummed IR and maps event fields to the wire format", async () => {
    await withServer(
      (path) =>
        path === "/v1/deploy"
          ? { status: "accepted", version: 1 }
          : { ingested: 1, matched: {}, reversed: {}, cost_minor: 0 },
      async (endpoint, requests) => {
        const client = billing.connect({ endpoint, token: "secret" })
        const deployed = await client.deploy()
        expect(deployed).toEqual({ status: "accepted", version: 1 })
        expect(requests[0]!.path).toBe("/v1/deploy")
        expect(requests[0]!.body).toMatchObject({ checksum: billing.checksum })

        await client.track("compute.done", {
          customer: "acme",
          properties: { status: "success", duration_s: 12.5 },
          cost: usdCents(42),
          timestamp: new Date("2026-08-17T12:00:00Z")
        })
        expect(requests[1]!.body).toEqual({
          events: [
            {
              name: "compute.done",
              external_customer_id: "acme",
              timestamp: "2026-08-17T12:00:00.000Z",
              properties: { status: "success", duration_s: 12.5 },
              _cost: { amount: 0.42, currency: "USD" }
            }
          ]
        })
      }
    )
  })

  it("resolves entitlements and gates with allowed()", async () => {
    const entitlements = {
      customer: "acme",
      products: ["pro"],
      entitlements: [
        { id: "sso", product: "pro", type: "flag" },
        {
          id: "api_quota",
          product: "pro",
          type: "metered",
          meter: "api_calls",
          limit: 10,
          used: 12,
          remaining: 0,
          exceeded: true
        }
      ],
      enforcement: "ok",
      violations: []
    }
    await withServer(
      () => entitlements,
      async (endpoint) => {
        const client = billing.connect({ endpoint })
        expect(await client.allowed("acme", "sso")).toBe(true)
        expect(await client.allowed("acme", "api_quota")).toBe(false)
        expect(await client.allowed("acme", "seats")).toBe(false) // not granted
      }
    )
  })

  it("surfaces server errors with their message", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 409
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ error: "no billing configuration deployed" }))
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const client = billing.connect({ endpoint: `http://127.0.0.1:${port}` })
      await expect(client.track("api.request")).rejects.toThrow(
        /no billing configuration deployed/
      )
    } finally {
      server.close()
    }
  })
})

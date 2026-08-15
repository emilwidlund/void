import { Effect, Either } from "effect"
import { describe, expect, it } from "vitest"
import { CompileError, compile, renderDiagnostic, shiftDecimal } from "../src/index.js"

const run = (source: string) => Effect.runSync(Effect.either(compile(source)))

describe("shiftDecimal", () => {
  it("converts major units to minor units", () => {
    expect(shiftDecimal("29", 2)).toBe("2900")
    expect(shiftDecimal("29.99", 2)).toBe("2999")
    expect(shiftDecimal("0.001", 2)).toBe("0.1")
    expect(shiftDecimal("0.5", 2)).toBe("50")
    expect(shiftDecimal("10", 0)).toBe("10")
    expect(shiftDecimal("0.00001", 2)).toBe("0.001")
  })
})

describe("compile", () => {
  it("compiles a full config to IR", () => {
    const outcome = run(`
      meter api_calls {
        filter event.name == "api.request"
        aggregate count
      }
      product pro {
        name "Pro Plan"
        price recurring monthly 29 USD
        meter api_calls {
          per_unit 10 USD_CENTS
          included 10_000
        }
      }
    `)
    expect(Either.isRight(outcome)).toBe(true)
    if (!Either.isRight(outcome)) return
    expect(outcome.right.diagnostics).toEqual([])
    expect(outcome.right.ir).toEqual({
      version: 1,
      meters: [
        {
          id: "api_calls",
          filter: {
            type: "comparison",
            property: "event.name",
            op: "eq",
            value: "api.request"
          },
          aggregation: { type: "count" },
          unit: null,
          reverse: null
        }
      ],
      outcomes: [],
      products: [
        {
          id: "pro",
          name: "Pro Plan",
          prices: [
            {
              type: "recurring",
              interval: "month",
              amount: { currency: "USD", amount: "2900" }
            },
            {
              type: "metered",
              meter: "api_calls",
              per_unit: { currency: "USD", amount: "10" },
              included_units: 10000,
              per: null,
              unit_factor: 1
            }
          ],
          entitlements: []
        }
      ],
      invariants: [],
      overrides: []
    })
  })

  it("normalizes units and emits the conversion factor", () => {
    const outcome = run(`
      meter compute {
        aggregate sum(event.duration_ms)
        unit ms
      }
      product pro {
        name "Pro"
        meter compute { per_unit 0.001 USD per second }
      }
    `)
    expect(Either.isRight(outcome)).toBe(true)
    if (!Either.isRight(outcome)) return
    expect(outcome.right.ir.meters[0]?.unit).toBe("millisecond")
    expect(outcome.right.ir.products[0]?.prices[0]).toEqual({
      type: "metered",
      meter: "compute",
      per_unit: { currency: "USD", amount: "0.1" },
      included_units: 0,
      per: "second",
      // 1000 meter-milliseconds make up one priced second
      unit_factor: 1000
    })
  })

  it("accepts scalar as the unit of counted things", () => {
    const outcome = run(`
      meter llm { aggregate sum(event.tokens)  unit scalar }
      product pro {
        name "Pro"
        meter llm { per_unit 0.002 USD_CENTS per scalar }
      }
    `)
    expect(Either.isRight(outcome)).toBe(true)
    if (!Either.isRight(outcome)) return
    expect(outcome.right.diagnostics).toEqual([])
    expect(outcome.right.ir.meters[0]?.unit).toBe("scalar")
    expect(outcome.right.ir.products[0]?.prices[0]).toMatchObject({
      per: "scalar",
      unit_factor: 1
    })
  })

  it("rejects made-up units", () => {
    const outcome = run(`
      meter llm { aggregate sum(event.tokens)  unit tokens }
      product pro { name "Pro" meter llm { per_unit 1 USD per request } }
    `)
    expect(Either.isLeft(outcome)).toBe(true)
    if (!Either.isLeft(outcome)) return
    const codes = outcome.left.diagnostics.filter((d) => d.code === "VOID122")
    expect(codes).toHaveLength(2)
    expect(codes[0]?.message).toContain("counts are `scalar`")
  })

  it("compiles reverse_on with a time window in seconds", () => {
    const outcome = run(`
      meter tickets {
        filter event.name == "ticket.closed"
        aggregate count
        reverse_on event.name == "ticket.reopened" within 7 days
      }
    `)
    expect(Either.isRight(outcome)).toBe(true)
    if (!Either.isRight(outcome)) return
    expect(outcome.right.ir.meters[0]?.reverse).toEqual({
      filter: {
        type: "comparison",
        property: "event.name",
        op: "eq",
        value: "ticket.reopened"
      },
      window_s: 604800
    })
  })

  it("compiles outcome chains and prices them like meters", () => {
    const outcome = run(`
      outcome ticket_resolution {
        correlate event.ticket_id
        step event.name == "ticket.opened"
        step event.name == "ticket.closed" and event.resolution == "solved"
        fail_on event.name == "ticket.reopened" within 7 days
      }
      product agent {
        name "Agent"
        outcome ticket_resolution { per_unit 2 USD }
      }
    `)
    expect(Either.isRight(outcome)).toBe(true)
    if (!Either.isRight(outcome)) return
    expect(outcome.right.ir.outcomes).toEqual([
      {
        id: "ticket_resolution",
        correlate: "event.ticket_id",
        steps: [
          { type: "comparison", property: "event.name", op: "eq", value: "ticket.opened" },
          {
            type: "and",
            operands: [
              {
                type: "comparison",
                property: "event.name",
                op: "eq",
                value: "ticket.closed"
              },
              {
                type: "comparison",
                property: "event.resolution",
                op: "eq",
                value: "solved"
              }
            ]
          }
        ],
        fail: {
          filter: {
            type: "comparison",
            property: "event.name",
            op: "eq",
            value: "ticket.reopened"
          },
          window_s: 604800
        }
      }
    ])
    expect(outcome.right.ir.products[0]?.prices[0]).toMatchObject({
      type: "metered",
      meter: "ticket_resolution",
      per: null,
      unit_factor: 1
    })
  })

  it("compiles customer overrides", () => {
    const outcome = run(`
      meter api_calls { aggregate count }
      product pro {
        name "Pro"
        meter api_calls { per_unit 10 USD_CENTS }
      }
      override customer "acme" {
        until "2027-01-01"
        price recurring monthly 19 USD
        meter api_calls { per_unit 8 USD_CENTS  included 50_000 }
        entitlement seats { limit 20 }
      }
    `)
    expect(Either.isRight(outcome)).toBe(true)
    if (!Either.isRight(outcome)) return
    expect(outcome.right.ir.overrides).toEqual([
      {
        customer: "acme",
        until: "2027-01-01",
        prices: [
          {
            type: "recurring",
            interval: "month",
            amount: { currency: "USD", amount: "1900" }
          },
          {
            type: "metered",
            meter: "api_calls",
            per_unit: { currency: "USD", amount: "8" },
            included_units: 50000,
            per: null,
            unit_factor: 1
          }
        ],
        entitlements: [{ type: "limit", id: "seats", limit: 20 }]
      }
    ])
  })

  it("holds overrides to the same static invariants", () => {
    const outcome = run(`
      meter api_calls { aggregate count }
      product pro {
        name "Pro"
        meter api_calls { per_unit 10 USD_CENTS }
      }
      invariant "API price floor" { price(api_calls) >= 5 USD_CENTS }
      override customer "megacorp" {
        meter api_calls { per_unit 2 USD_CENTS }
      }
    `)
    expect(Either.isLeft(outcome)).toBe(true)
    if (!Either.isLeft(outcome)) return
    const violation = outcome.left.diagnostics.find((d) => d.code === "VOID133")
    expect(violation?.message).toContain("override for `megacorp`")
  })

  it("compiles margin pricing to a fraction", () => {
    const outcome = run(`
      meter compute_seconds { aggregate sum(event.duration_s) }
      product pro {
        name "Pro"
        meter compute_seconds { margin 60% }
      }
    `)
    expect(Either.isRight(outcome)).toBe(true)
    if (!Either.isRight(outcome)) return
    expect(outcome.right.ir.products[0]?.prices).toEqual([
      { type: "metered_margin", meter: "compute_seconds", margin: 0.6 }
    ])
  })

  it("compiles entitlements in all three forms", () => {
    const outcome = run(`
      meter api_calls {
        filter event.name == "api.request"
        aggregate count
      }
      product pro {
        name "Pro"
        price recurring monthly 29 USD
        entitlement sso
        entitlement seats { limit 5 }
        entitlement api_quota {
          meter api_calls
          limit 100_000
        }
      }
    `)
    expect(Either.isRight(outcome)).toBe(true)
    if (!Either.isRight(outcome)) return
    expect(outcome.right.ir.products[0]?.entitlements).toEqual([
      { type: "flag", id: "sso" },
      { type: "limit", id: "seats", limit: 5 },
      { type: "metered", id: "api_quota", meter: "api_calls", limit: 100000 }
    ])
  })

  it("compiles invariants: static ones prove, runtime ones reach the IR", () => {
    const outcome = run(`
      meter api_calls { aggregate count }
      meter compute { aggregate sum(event.duration_s) }
      product pro {
        name "Pro"
        meter api_calls { per_unit 10 USD_CENTS }
        meter compute { margin 60% }
      }
      invariant "API price floor" { price(api_calls) >= 5 USD_CENTS }
      invariant "compute stays profitable" { margin(compute) >= 40% }
      invariant "bill shock" { spend(customer) <= 500 USD }
      invariant "profitable customers" { margin(customer) >= 20% }
    `)
    expect(Either.isRight(outcome)).toBe(true)
    if (!Either.isRight(outcome)) return
    expect(outcome.right.ir.invariants).toEqual([
      {
        name: "API price floor",
        metric: "price",
        meter: "api_calls",
        op: "gte",
        threshold: 5,
        currency: "USD",
        behavior: null
      },
      {
        name: "compute stays profitable",
        metric: "margin",
        meter: "compute",
        op: "gte",
        threshold: 0.4,
        currency: null,
        behavior: null
      },
      {
        name: "bill shock",
        metric: "spend",
        meter: null,
        op: "lte",
        threshold: 50000,
        currency: "USD",
        behavior: null
      },
      {
        name: "profitable customers",
        metric: "margin",
        meter: null,
        op: "gte",
        threshold: 0.2,
        currency: null,
        behavior: null
      }
    ])
  })

  it("compiles invariant behaviors", () => {
    const outcome = run(`
      invariant "bill shock" { spend(customer) <= 500 USD else cap }
      invariant "hard stop" { spend(customer) <= 1000 USD else block }
    `)
    expect(Either.isRight(outcome)).toBe(true)
    if (!Either.isRight(outcome)) return
    expect(outcome.right.ir.invariants.map((i) => i.behavior)).toEqual(["cap", "block"])
  })

  it("softens static violations to warnings with `else warn`", () => {
    const outcome = run(`
      meter api_calls { aggregate count }
      product cheap {
        name "Cheap"
        meter api_calls { per_unit 2 USD_CENTS }
      }
      invariant "API price floor" { price(api_calls) >= 5 USD_CENTS else warn }
    `)
    expect(Either.isRight(outcome)).toBe(true)
    if (!Either.isRight(outcome)) return
    const warning = outcome.right.diagnostics.find((d) => d.code === "VOID133")
    expect(warning?.severity).toBe("warning")
  })

  it("fails compilation when a static invariant is violated", () => {
    const outcome = run(`
      meter api_calls { aggregate count }
      product cheap {
        name "Cheap"
        meter api_calls { per_unit 2 USD_CENTS }
      }
      invariant "API price floor" { price(api_calls) >= 5 USD_CENTS }
    `)
    expect(Either.isLeft(outcome)).toBe(true)
    if (!Either.isLeft(outcome)) return
    const violation = outcome.left.diagnostics.find((d) => d.code === "VOID133")
    expect(violation?.message).toContain("API price floor")
    expect(violation?.message).toContain("cheap")
  })

  it("flattens chained and-filters", () => {
    const outcome = run(`
      meter m {
        filter event.a == 1 and event.b == 2 and event.c == true
        aggregate count
      }
    `)
    if (!Either.isRight(outcome)) throw new Error("expected success")
    expect(outcome.right.ir.meters[0]?.filter).toEqual({
      type: "and",
      operands: [
        { type: "comparison", property: "event.a", op: "eq", value: 1 },
        { type: "comparison", property: "event.b", op: "eq", value: 2 },
        { type: "comparison", property: "event.c", op: "eq", value: true }
      ]
    })
  })

  it("fails with accumulated diagnostics on semantic errors", () => {
    const outcome = run(`
      product pro {
        meter nope { per_unit 1 USD }
      }
    `)
    expect(Either.isLeft(outcome)).toBe(true)
    if (!Either.isLeft(outcome)) return
    expect(outcome.left).toBeInstanceOf(CompileError)
    const codes = outcome.left.diagnostics.map((d) => d.code).sort()
    expect(codes).toEqual(["VOID101", "VOID104"])
  })

  it("fails on syntax errors", () => {
    const outcome = run("meter {")
    expect(Either.isLeft(outcome)).toBe(true)
    if (!Either.isLeft(outcome)) return
    expect(outcome.left.diagnostics[0]?.code).toBe("VOID010")
  })

  it("renders diagnostics with a caret pointing at the span", () => {
    const source = 'product pro {\n  price recurring monthly 1 usd\n}'
    const outcome = run(source)
    if (!Either.isLeft(outcome)) throw new Error("expected failure")
    const currencyError = outcome.left.diagnostics.find((d) => d.code === "VOID105")
    if (currencyError === undefined) throw new Error("expected VOID105")
    const rendered = renderDiagnostic(currencyError, source, "billing.void")
    expect(rendered).toContain("--> billing.void:2:29")
    expect(rendered).toContain("^^^")
  })
})

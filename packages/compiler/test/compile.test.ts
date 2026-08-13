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
        price metered api_calls {
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
          aggregation: { type: "count" }
        }
      ],
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
              included_units: 10000
            }
          ]
        }
      ]
    })
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
        price metered nope { per_unit 1 USD }
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

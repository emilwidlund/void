import { describe, expect, it } from "vitest"
import { tokenize } from "../src/Lexer.js"
import { parse } from "../src/Parser.js"

const parseSource = (source: string) => parse(tokenize(source).tokens)

describe("parse", () => {
  it("parses a meter with filter and aggregate", () => {
    const { diagnostics, file } = parseSource(`
      meter compute_seconds {
        filter event.name == "compute.done"
        aggregate sum(event.duration_s)
      }
    `)
    expect(diagnostics).toEqual([])
    const meter = file.decls[0]
    expect(meter?._tag).toBe("MeterDecl")
    if (meter?._tag !== "MeterDecl") return
    expect(meter.id.name).toBe("compute_seconds")
    expect(meter.fields).toHaveLength(2)
    const [filter, aggregate] = meter.fields
    expect(filter?._tag).toBe("FilterField")
    if (filter?._tag === "FilterField") {
      expect(filter.expr).toMatchObject({
        _tag: "Comparison",
        path: { segments: ["event", "name"] },
        op: "==",
        value: { _tag: "StringLiteral", value: "compute.done" }
      })
    }
    expect(aggregate?._tag).toBe("AggregateField")
    if (aggregate?._tag === "AggregateField") {
      expect(aggregate.aggregate).toMatchObject({
        _tag: "PropertyAggregate",
        fn: "sum",
        path: { segments: ["event", "duration_s"] }
      })
    }
  })

  it("parses and/or with `and` binding tighter than `or`", () => {
    const { file } = parseSource(`
      meter m {
        filter event.a == 1 or event.b == 2 and event.c == 3
        aggregate count
      }
    `)
    const meter = file.decls[0]
    if (meter?._tag !== "MeterDecl") throw new Error("expected meter")
    const filter = meter.fields[0]
    if (filter?._tag !== "FilterField") throw new Error("expected filter")
    expect(filter.expr).toMatchObject({
      _tag: "Logical",
      op: "or",
      left: { _tag: "Comparison" },
      right: { _tag: "Logical", op: "and" }
    })
  })

  it("parses a product with a recurring price and a meter binding", () => {
    const { diagnostics, file } = parseSource(`
      product pro {
        name "Pro Plan"
        price recurring monthly 29 USD
        meter api_calls {
          per_unit 10 USD_CENTS
          included 10_000
        }
      }
    `)
    expect(diagnostics).toEqual([])
    const product = file.decls[0]
    if (product?._tag !== "ProductDecl") throw new Error("expected product")
    expect(product.fields).toHaveLength(3)
    expect(product.fields[1]).toMatchObject({
      _tag: "RecurringPriceField",
      interval: "monthly",
      money: { amount: "29", currency: "USD" }
    })
    expect(product.fields[2]).toMatchObject({
      _tag: "MeterBindingField",
      meter: { name: "api_calls" },
      fields: [
        { _tag: "PerUnitField", money: { amount: "10", currency: "USD_CENTS" } },
        { _tag: "IncludedField", value: "10000" }
      ]
    })
  })

  it("rejects the removed `price metered` syntax with a migration hint", () => {
    const { diagnostics } = parseSource(`
      product pro {
        price metered api_calls { per_unit 1 USD }
      }
    `)
    expect(diagnostics[0]?.message).toContain(
      "`price metered` has been replaced by `meter <id> { ... }`"
    )
  })

  it("reports syntax errors with position info", () => {
    const { diagnostics } = parseSource("meter {")
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      code: "VOID010",
      span: { start: { line: 1, column: 7 } }
    })
    expect(diagnostics[0]?.message).toContain("expected meter name")
  })

  it("rejects unknown top-level declarations", () => {
    const { diagnostics } = parseSource("plan pro { }")
    expect(diagnostics[0]?.message).toContain(
      "expected `meter`, `product` or `invariant`"
    )
  })

  it("rejects unknown aggregation functions", () => {
    const { diagnostics } = parseSource("meter m { aggregate median(event.x) }")
    expect(diagnostics[0]?.message).toContain("unknown aggregation `median`")
  })
})

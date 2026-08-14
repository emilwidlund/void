import { describe, expect, it } from "vitest"
import {
  blockContext,
  completionsAt,
  computeDiagnostics,
  definitionAt,
  hoverAt,
  knownMeters
} from "../src/Core.js"

const config = `meter api_calls {
  filter event.name == "api.request"
  aggregate count
  unit requests
}

product pro {
  name "Pro"
  price recurring monthly 29 USD
  entitlement api_quota {
    meter api_calls
    limit 100_000
  }
  meter api_calls {
    per_unit 10 USD_CENTS
    included 10_000
  }
}

invariant "floor" { price(api_calls) >= 5 USD_CENTS }
`

describe("computeDiagnostics", () => {
  it("maps checker errors to 0-based LSP ranges", () => {
    const source = `product pro {\n  name "Pro"\n  meter nope { per_unit 1 USD }\n}`
    const diagnostics = computeDiagnostics(source)
    const unknown = diagnostics.find((d) => d.code === "VOID101")
    expect(unknown).toBeDefined()
    expect(unknown!.severity).toBe(1)
    // `nope` is on line 3 (0-based 2), column 9 (0-based 8)
    expect(unknown!.range.start).toEqual({ line: 2, character: 8 })
  })

  it("maps warnings to severity 2 and accumulates parser + checker output", () => {
    const source = `meter m {\n  filter customer.plan == "pro"\n  aggregate count\n}`
    const diagnostics = computeDiagnostics(source)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.severity).toBe(2)
    expect(diagnostics[0]!.code).toBe("VOID108")
  })

  it("reports parse errors without running the checker", () => {
    const diagnostics = computeDiagnostics("meter {")
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.code).toBe("VOID010")
  })
})

describe("definitionAt and hoverAt", () => {
  const offsetOf = (needle: string, occurrence = 0): number => {
    let index = -1
    for (let i = 0; i <= occurrence; i += 1) index = config.indexOf(needle, index + 1)
    return index + 1
  }

  it("resolves a product meter binding to the top-level declaration", () => {
    // the second `meter api_calls` is the binding inside the product
    const offset = config.indexOf("meter api_calls {", 10) + "meter ap".length
    const range = definitionAt(config, offset)
    expect(range).toEqual({
      start: { line: 0, character: 6 },
      end: { line: 0, character: 15 }
    })
  })

  it("resolves entitlement and invariant references too", () => {
    const entitlementRef = offsetOf("meter api_calls\n")
    expect(definitionAt(config, entitlementRef + 8)).not.toBeNull()
    const invariantRef = config.indexOf("price(api_calls)") + 8
    expect(definitionAt(config, invariantRef)).not.toBeNull()
  })

  it("hover renders the meter summary", () => {
    const offset = config.indexOf("price(api_calls)") + 8
    const hover = hoverAt(config, offset)
    expect(hover).toContain("meter api_calls")
    expect(hover).toContain("aggregate: `count`")
    expect(hover).toContain("unit: `requests`")
    expect(hover).toContain('filter: `event.name == "api.request"`')
  })

  it("returns null outside references", () => {
    expect(definitionAt(config, config.indexOf("29 USD"))).toBeNull()
  })
})

describe("blockContext and completions", () => {
  it("detects nesting", () => {
    expect(blockContext(config, 0)).toEqual([])
    expect(blockContext(config, config.indexOf("aggregate"))).toEqual(["meter"])
    expect(blockContext(config, config.indexOf("per_unit"))).toEqual(["product", "meter"])
    expect(blockContext(config, config.indexOf("limit"))).toEqual([
      "product",
      "entitlement"
    ])
    expect(blockContext(config, config.indexOf("price(api_calls)"))).toEqual(["invariant"])
  })

  it("is not fooled by braces in strings or comments", () => {
    const tricky = `# a { comment\nmeter m {\n  filter event.name == "{x}"\n  aggregate count\n}\n`
    expect(blockContext(tricky, tricky.length)).toEqual([])
  })

  it("offers declarations at top level and fields per block", () => {
    expect(completionsAt(config, 0).map((c) => c.label)).toEqual([
      "meter",
      "product",
      "invariant"
    ])
    const meterFields = completionsAt(config, config.indexOf("aggregate"))
    expect(meterFields.map((c) => c.label)).toContain("filter")
    expect(meterFields.map((c) => c.label)).toContain("unit")
    const pricing = completionsAt(config, config.indexOf("per_unit"))
    expect(pricing.map((c) => c.label)).toEqual(["per_unit", "included", "margin", "per"])
    const invariant = completionsAt(config, config.indexOf("price(api_calls)"))
    expect(invariant.map((c) => c.label)).toContain("spend")
    expect(invariant.map((c) => c.label)).toContain("api_calls")
  })

  it("completes units after `unit` and after `per`", () => {
    const source = `meter compute {\n  aggregate sum(event.duration_ms)\n  unit `
    const units = completionsAt(source, source.length).map((c) => c.label)
    expect(units).toContain("ms")
    expect(units).toContain("seconds")
    expect(units).toContain("gb")

    const pricing = `meter m { aggregate count }\nproduct p {\n  meter m {\n    per_unit 1 USD per `
    expect(completionsAt(pricing, pricing.length).map((c) => c.label)).toContain("seconds")
  })

  it("completes units while a partial word is typed", () => {
    const source = `meter compute {\n  aggregate count\n  unit sec`
    expect(completionsAt(source, source.length).map((c) => c.label)).toContain("seconds")
  })

  it("completes currencies after an amount and `per` after a currency", () => {
    const amount = `meter m { aggregate count }\nproduct p {\n  meter m {\n    per_unit 0.001 `
    expect(completionsAt(amount, amount.length).map((c) => c.label)).toContain("USD")
    const currency = `${amount}USD `
    expect(completionsAt(currency, currency.length).map((c) => c.label)).toEqual(["per"])
  })

  it("completes intervals and currencies in a price line", () => {
    const price = `product p {\n  price `
    expect(completionsAt(price, price.length).map((c) => c.label)).toEqual(["recurring"])
    const interval = `product p {\n  price recurring `
    expect(completionsAt(interval, interval.length).map((c) => c.label)).toContain(
      "monthly"
    )
    const amount = `product p {\n  price recurring monthly 29 `
    expect(completionsAt(amount, amount.length).map((c) => c.label)).toContain("USD")
  })

  it("completes behaviors after `else` and subjects inside metric calls", () => {
    const behaviors = `invariant "x" {\n  spend(customer) <= 500 USD else `
    expect(completionsAt(behaviors, behaviors.length).map((c) => c.label)).toEqual([
      "warn",
      "cap",
      "block",
      "notify"
    ])
    const spendArg = `invariant "x" {\n  spend(`
    expect(completionsAt(spendArg, spendArg.length).map((c) => c.label)).toEqual([
      "customer"
    ])
    const priceArg = `meter api_calls { aggregate count }\ninvariant "x" {\n  price(`
    expect(completionsAt(priceArg, priceArg.length).map((c) => c.label)).toEqual([
      "api_calls"
    ])
  })

  it("completes meter names after `meter` in product context only", () => {
    const binding = `meter api_calls { aggregate count }\nproduct p {\n  meter `
    expect(completionsAt(binding, binding.length).map((c) => c.label)).toEqual([
      "api_calls"
    ])
    // top-level `meter ` declares a new id — no reference completion
    const topLevel = `meter api_calls { aggregate count }\nmeter `
    expect(completionsAt(topLevel, topLevel.length)).toEqual([])
  })

  it("does not offer currencies for margin thresholds", () => {
    const margin = `invariant "x" {\n  margin(customer) >= 20 `
    expect(completionsAt(margin, margin.length)).toEqual([])
  })

  it("walks the filter follow-set: event -> operator -> literal -> and/or", () => {
    const base = `meter m {\n  filter `
    expect(completionsAt(base, base.length).map((c) => c.label)).toEqual(["event"])
    const afterPath = `${base}event.status `
    expect(completionsAt(afterPath, afterPath.length).map((c) => c.label)).toContain("==")
    const afterLiteral = `${base}event.status == "ok" `
    expect(completionsAt(afterLiteral, afterLiteral.length).map((c) => c.label)).toEqual([
      "and",
      "or"
    ])
    const afterLogical = `${base}event.status == "ok" and `
    expect(completionsAt(afterLogical, afterLogical.length).map((c) => c.label)).toEqual([
      "event"
    ])
    const afterParen = `${base}(event.a == 1 or event.b == 2) `
    expect(completionsAt(afterParen, afterParen.length).map((c) => c.label)).toEqual([
      "and",
      "or"
    ])
  })

  it("suggests event inside aggregation calls", () => {
    const source = `meter m {\n  aggregate sum(`
    expect(completionsAt(source, source.length).map((c) => c.label)).toEqual(["event"])
  })

  it("walks the invariant follow-set: call -> operator -> threshold -> else", () => {
    const call = `invariant "x" {\n  spend(customer) `
    expect(completionsAt(call, call.length).map((c) => c.label)).toContain("<=")
    const threshold = `invariant "x" {\n  spend(customer) <= 500 USD `
    expect(completionsAt(threshold, threshold.length).map((c) => c.label)).toEqual(["else"])
    const percent = `invariant "x" {\n  margin(customer) >= 20% `
    expect(completionsAt(percent, percent.length).map((c) => c.label)).toEqual(["else"])
  })

  it("stays quiet once a line is complete", () => {
    for (const done of [
      `meter m {\n  unit seconds `,
      `meter m {\n  aggregate count `,
      `product p {\n  price recurring monthly 29 USD `,
      `invariant "x" {\n  spend(customer) <= 500 USD else cap `
    ]) {
      expect(completionsAt(done, done.length)).toEqual([])
    }
  })

  it("finds meter names by regex while the file fails to parse", () => {
    const broken = `meter api_calls {\n  aggregate count\n}\nproduct pro {\n  meter `
    expect(knownMeters(broken)).toEqual(["api_calls"])
    const completions = completionsAt(broken, broken.length)
    expect(completions.map((c) => c.label)).toContain("api_calls")
  })
})

import { describe, expect, it } from "vitest"
import { check } from "../src/Checker.js"
import { tokenize } from "../src/Lexer.js"
import { parse } from "../src/Parser.js"

const checkSource = (source: string) => check(parse(tokenize(source).tokens).file)

describe("check", () => {
  it("accepts a valid file", () => {
    const diagnostics = checkSource(`
      meter api_calls {
        filter event.name == "api.request"
        aggregate count
      }
      product pro {
        name "Pro"
        price metered api_calls { per_unit 10 USD_CENTS }
      }
    `)
    expect(diagnostics).toEqual([])
  })

  it("reports duplicate declarations", () => {
    const diagnostics = checkSource(`
      meter a { aggregate count }
      product a { name "A" price recurring monthly 1 USD }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID100")
  })

  it("reports missing aggregate", () => {
    const diagnostics = checkSource(`meter a { filter event.x == 1 }`)
    expect(diagnostics.map((d) => d.code)).toContain("VOID102")
  })

  it("reports duplicate meter fields", () => {
    const diagnostics = checkSource(`meter a { aggregate count aggregate count }`)
    expect(diagnostics.map((d) => d.code)).toContain("VOID103")
  })

  it("reports unknown meter references", () => {
    const diagnostics = checkSource(`
      product pro {
        name "Pro"
        price metered nope { per_unit 1 USD }
      }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID101")
  })

  it("reports missing product name and missing per_unit", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      product pro { price metered m { } }
    `)
    const codes = diagnostics.map((d) => d.code)
    expect(codes).toContain("VOID104")
    expect(codes).toContain("VOID109")
  })

  it("reports invalid currencies", () => {
    const diagnostics = checkSource(`
      product pro { name "Pro" price recurring monthly 1 dollars }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID105")
  })

  it("reports fractional included units", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      product pro {
        name "Pro"
        price metered m { per_unit 1 USD included 1.5 }
      }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID107")
  })

  it("warns on filter paths outside event", () => {
    const diagnostics = checkSource(`
      meter m {
        filter customer.plan == "pro"
        aggregate count
      }
    `)
    expect(diagnostics).toMatchObject([{ code: "VOID108", severity: "warning" }])
  })

  it("warns on products with no prices", () => {
    const diagnostics = checkSource(`product empty { name "Empty" }`)
    expect(diagnostics).toMatchObject([{ code: "VOID110", severity: "warning" }])
  })
})

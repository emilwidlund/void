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
        meter api_calls { per_unit 10 USD_CENTS }
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
        meter nope { per_unit 1 USD }
      }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID101")
  })

  it("reports missing product name and missing per_unit", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      product pro { meter m { } }
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
        meter m { per_unit 1 USD included 1.5 }
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

  it("accepts holding invariants", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      product pro { name "P" meter m { margin 60% } }
      invariant "profitable" { margin(m) >= 40% }
      invariant "bill shock" { spend(customer) <= 500 USD }
    `)
    expect(diagnostics).toEqual([])
  })

  it("reports violated static margin invariants", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      product pro { name "P" meter m { margin 30% } }
      invariant "profitable" { margin(m) >= 40% }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID133")
  })

  it("reports unknown invariant metrics", () => {
    const diagnostics = checkSource(`invariant "x" { revenue(customer) >= 1 USD }`)
    expect(diagnostics.map((d) => d.code)).toContain("VOID130")
  })

  it("reports metric/argument mismatches", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      invariant "a" { spend(m) <= 1 USD }
      invariant "b" { price(customer) >= 1 USD }
    `)
    const codes = diagnostics.map((d) => d.code)
    expect(codes.filter((c) => c === "VOID131")).toHaveLength(2)
  })

  it("reports threshold type mismatches", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      invariant "a" { price(m) >= 40% }
      invariant "b" { margin(m) >= 1 USD }
    `)
    expect(diagnostics.filter((d) => d.code === "VOID132")).toHaveLength(2)
  })

  it("reports duplicate invariant names", () => {
    const diagnostics = checkSource(`
      invariant "x" { spend(customer) <= 1 USD }
      invariant "x" { spend(customer) <= 2 USD }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID134")
  })

  it("reports unknown invariant behaviors", () => {
    const diagnostics = checkSource(
      `invariant "x" { spend(customer) <= 1 USD else explode }`
    )
    expect(diagnostics.map((d) => d.code)).toContain("VOID136")
  })

  it("rejects behaviors outside the validity matrix", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      product pro { name "P" meter m { per_unit 10 USD_CENTS } }
      invariant "a" { price(m) >= 5 USD_CENTS else cap }
      invariant "b" { margin(customer) >= 20% else block }
    `)
    expect(diagnostics.filter((d) => d.code === "VOID137")).toHaveLength(2)
  })

  it("accepts valid behavior combinations", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      product pro { name "P" meter m { per_unit 10 USD_CENTS } }
      invariant "a" { price(m) >= 5 USD_CENTS else warn }
      invariant "b" { spend(customer) <= 500 USD else cap }
      invariant "c" { spend(customer) <= 1000 USD else block }
      invariant "d" { margin(customer) >= 20% else notify }
    `)
    expect(diagnostics).toEqual([])
  })

  it("reports invariant currency mismatches", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      product pro { name "P" meter m { per_unit 10 EUR_CENTS } }
      invariant "floor" { price(m) >= 5 USD_CENTS }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID135")
  })

  it("accepts a well-formed outcome and its references", () => {
    const diagnostics = checkSource(`
      outcome resolution {
        correlate event.ticket_id
        step event.name == "ticket.closed"
        fail_on event.name == "ticket.reopened" within 7 days
      }
      product agent {
        name "A"
        outcome resolution { per_unit 2 USD }
        entitlement quota { meter resolution limit 100 }
      }
      invariant "floor" { price(resolution) >= 1 USD }
    `)
    expect(diagnostics).toEqual([])
  })

  it("requires correlate and at least one step on outcomes", () => {
    const diagnostics = checkSource(`outcome empty { }`)
    const codes = diagnostics.map((d) => d.code)
    expect(codes).toContain("VOID140")
    expect(codes).toContain("VOID141")
  })

  it("keeps meter and outcome binding namespaces straight", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      outcome o { correlate event.id step event.name == "x" }
      product p {
        name "P"
        outcome m { per_unit 1 USD }
        meter o { per_unit 1 USD }
      }
    `)
    expect(diagnostics.filter((d) => d.code === "VOID142")).toHaveLength(2)
  })

  it("rejects margin pricing on outcomes", () => {
    const diagnostics = checkSource(`
      outcome o { correlate event.id step event.name == "x" }
      product p { name "P" outcome o { margin 50% } }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID143")
  })

  it("rejects reverse_on with non-reversible aggregations", () => {
    const diagnostics = checkSource(`
      meter m {
        aggregate avg(event.latency)
        reverse_on event.name == "x"
      }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID123")
  })

  it("rejects non-time reverse windows", () => {
    const diagnostics = checkSource(`
      meter m {
        aggregate count
        reverse_on event.name == "x" within 5 gb
      }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID124")
  })

  it("rejects invalid override dates and name overrides", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      override customer "acme" {
        until "soon"
        name "Nope"
        meter m { per_unit 1 USD }
      }
    `)
    const codes = diagnostics.map((d) => d.code)
    expect(codes).toContain("VOID125")
    expect(codes).toContain("VOID126")
  })

  it("rejects duplicate overrides for a customer", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      override customer "acme" { meter m { per_unit 1 USD } }
      override customer "acme" { meter m { per_unit 2 USD } }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID127")
  })

  it("rejects pricing across unit dimensions", () => {
    const diagnostics = checkSource(`
      meter transfer { aggregate sum(event.bytes)  unit bytes }
      product pro { name "P" meter transfer { per_unit 1 USD per hour } }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID120")
  })

  it("accepts convertible units within a dimension", () => {
    const diagnostics = checkSource(`
      meter compute { aggregate sum(event.duration_ms)  unit ms }
      product pro { name "P" meter compute { per_unit 1 USD per hour } }
    `)
    expect(diagnostics).toEqual([])
  })

  it("rejects unknown units on meters and prices", () => {
    const diagnostics = checkSource(`
      meter llm { aggregate sum(event.tokens)  unit tokens }
      product pro { name "P" meter llm { per_unit 1 USD per request } }
    `)
    expect(diagnostics.filter((d) => d.code === "VOID122")).toHaveLength(2)
  })

  it("rejects pricing scalar counts per a dimensioned unit", () => {
    const diagnostics = checkSource(`
      meter api_calls { aggregate count  unit scalar }
      product pro { name "P" meter api_calls { per_unit 1 USD per hour } }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID120")
  })

  it("warns when a price declares a unit but the meter does not", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      product pro { name "P" meter m { per_unit 1 USD per second } }
    `)
    expect(diagnostics).toMatchObject([{ code: "VOID121", severity: "warning" }])
  })

  it("rejects combining per_unit and margin", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      product pro { name "P" meter m { per_unit 1 USD margin 50% } }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID117")
  })

  it("rejects margins outside (0, 100)", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      product pro { name "P" meter m { margin 100% } }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID118")
  })

  it("rejects included with margin pricing", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      product pro { name "P" meter m { margin 50% included 100 } }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID119")
  })

  it("accepts entitlements in all three forms", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      product pro {
        name "Pro"
        meter m { per_unit 1 USD }
        entitlement sso
        entitlement seats { limit 5 }
        entitlement quota { meter m limit 100 }
      }
    `)
    expect(diagnostics).toEqual([])
  })

  it("reports unknown meters in entitlements", () => {
    const diagnostics = checkSource(`
      product pro {
        name "Pro"
        price recurring monthly 1 USD
        entitlement quota { meter nope limit 100 }
      }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID101")
  })

  it("reports duplicate entitlements in a product", () => {
    const diagnostics = checkSource(`
      product pro {
        name "Pro"
        price recurring monthly 1 USD
        entitlement sso
        entitlement sso
      }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID111")
  })

  it("reports entitlement blocks without a limit", () => {
    const diagnostics = checkSource(`
      meter m { aggregate count }
      product pro {
        name "Pro"
        price recurring monthly 1 USD
        entitlement quota { meter m }
      }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID112")
  })

  it("reports duplicate fields inside an entitlement block", () => {
    const diagnostics = checkSource(`
      product pro {
        name "Pro"
        price recurring monthly 1 USD
        entitlement seats { limit 5 limit 10 }
      }
    `)
    expect(diagnostics.map((d) => d.code)).toContain("VOID103")
  })
})

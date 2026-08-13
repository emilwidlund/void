import { describe, expect, it } from "vitest"
import { tokenize } from "../src/Lexer.js"

describe("tokenize", () => {
  it("lexes idents, braces, strings and operators", () => {
    const { diagnostics, tokens } = tokenize('meter a { filter event.name == "x" }')
    expect(diagnostics).toEqual([])
    expect(tokens.map((t) => t.kind)).toEqual([
      "Ident",
      "Ident",
      "LBrace",
      "Ident",
      "Ident",
      "Dot",
      "Ident",
      "Op",
      "String",
      "RBrace",
      "EOF"
    ])
  })

  it("normalizes numbers with underscores and decimals", () => {
    const { tokens } = tokenize("10_000 0.001 29.99")
    expect(tokens.map((t) => t.value).slice(0, 3)).toEqual(["10000", "0.001", "29.99"])
  })

  it("unescapes string literals", () => {
    const { tokens } = tokenize('"a\\"b\\nc"')
    expect(tokens[0]?.value).toBe('a"b\nc')
  })

  it("skips comments", () => {
    const { tokens } = tokenize("# a comment\nmeter")
    expect(tokens.map((t) => t.kind)).toEqual(["Ident", "EOF"])
    expect(tokens[0]?.span.start.line).toBe(2)
  })

  it("tracks line and column positions", () => {
    const { tokens } = tokenize("meter a {\n  filter\n}")
    const filter = tokens.find((t) => t.text === "filter")
    expect(filter?.span.start).toEqual({ line: 2, column: 3, offset: 12 })
  })

  it("reports unterminated strings", () => {
    const { diagnostics } = tokenize('"oops')
    expect(diagnostics.map((d) => d.code)).toEqual(["VOID002"])
  })

  it("reports unexpected characters", () => {
    const { diagnostics } = tokenize("meter @")
    expect(diagnostics.map((d) => d.code)).toEqual(["VOID001"])
  })
})

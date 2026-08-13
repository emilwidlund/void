import type {
  Aggregate,
  ComparisonOp,
  Decl,
  FilterExpr,
  Identifier,
  Interval,
  Literal,
  MeterField,
  Money,
  PricingField,
  ProductField,
  PropertyPath,
  SourceFile
} from "./Ast.js"
import type { Diagnostic, Span } from "./Diagnostic.js"
import * as D from "./Diagnostic.js"
import type { Token } from "./Lexer.js"

export interface ParseResult {
  readonly file: SourceFile
  readonly diagnostics: ReadonlyArray<Diagnostic>
}

class ParseError {
  constructor(readonly diagnostic: Diagnostic) {}
}

const INTERVALS: ReadonlyArray<Interval> = ["monthly", "yearly", "weekly", "daily"]
const AGGREGATE_FNS = ["sum", "max", "min", "avg", "unique"] as const
const COMPARISON_OPS: ReadonlyArray<ComparisonOp> = ["==", "!=", ">", ">=", "<", "<="]

class Parser {
  private pos = 0

  constructor(private readonly tokens: ReadonlyArray<Token>) {}

  private peek(): Token {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1]!
  }

  private advance(): Token {
    const token = this.peek()
    if (token.kind !== "EOF") this.pos += 1
    return token
  }

  private fail(message: string, span?: Span): never {
    throw new ParseError(D.error("VOID010", message, span ?? this.peek().span))
  }

  private describe(token: Token): string {
    return token.kind === "EOF" ? "end of input" : `\`${token.text}\``
  }

  private expect(kind: Token["kind"], what: string): Token {
    const token = this.peek()
    if (token.kind !== kind) {
      this.fail(`expected ${what}, found ${this.describe(token)}`)
    }
    return this.advance()
  }

  private expectIdent(what: string): Identifier {
    const token = this.expect("Ident", what)
    return { name: token.value, span: token.span }
  }

  private expectKeyword(keyword: string): Token {
    const token = this.peek()
    if (token.kind !== "Ident" || token.value !== keyword) {
      this.fail(`expected \`${keyword}\`, found ${this.describe(token)}`)
    }
    return this.advance()
  }

  private peekKeyword(): string | undefined {
    const token = this.peek()
    return token.kind === "Ident" ? token.value : undefined
  }

  parseFile(): SourceFile {
    const decls: Array<Decl> = []
    while (this.peek().kind !== "EOF") {
      const keyword = this.peekKeyword()
      if (keyword === "meter") {
        decls.push(this.parseMeter())
      } else if (keyword === "product") {
        decls.push(this.parseProduct())
      } else {
        this.fail(
          `expected \`meter\` or \`product\` declaration, found ${this.describe(this.peek())}`
        )
      }
    }
    return { decls }
  }

  private parseMeter(): Decl {
    const start = this.expectKeyword("meter")
    const id = this.expectIdent("meter name")
    this.expect("LBrace", "`{`")
    const fields: Array<MeterField> = []
    while (this.peek().kind !== "RBrace" && this.peek().kind !== "EOF") {
      fields.push(this.parseMeterField())
    }
    const end = this.expect("RBrace", "`}`")
    return {
      _tag: "MeterDecl",
      id,
      fields,
      span: { start: start.span.start, end: end.span.end }
    }
  }

  private parseMeterField(): MeterField {
    const keyword = this.peekKeyword()
    if (keyword === "filter") {
      const start = this.advance()
      const expr = this.parseFilterExpr()
      return {
        _tag: "FilterField",
        expr,
        span: { start: start.span.start, end: expr.span.end }
      }
    }
    if (keyword === "aggregate") {
      const start = this.advance()
      const aggregate = this.parseAggregate()
      return {
        _tag: "AggregateField",
        aggregate,
        span: { start: start.span.start, end: aggregate.span.end }
      }
    }
    return this.fail(
      `expected \`filter\` or \`aggregate\`, found ${this.describe(this.peek())}`
    )
  }

  private parseAggregate(): Aggregate {
    const token = this.expect("Ident", "aggregation function")
    const fn = token.value
    if (fn === "count") {
      let end = token.span.end
      if (this.peek().kind === "LParen") {
        this.advance()
        end = this.expect("RParen", "`)`").span.end
      }
      return { _tag: "Count", span: { start: token.span.start, end } }
    }
    if ((AGGREGATE_FNS as ReadonlyArray<string>).includes(fn)) {
      this.expect("LParen", "`(`")
      const path = this.parsePropertyPath()
      const end = this.expect("RParen", "`)`")
      return {
        _tag: "PropertyAggregate",
        fn: fn as (typeof AGGREGATE_FNS)[number],
        path,
        span: { start: token.span.start, end: end.span.end }
      }
    }
    return this.fail(
      `unknown aggregation \`${fn}\` (expected one of: count, ${AGGREGATE_FNS.join(", ")})`,
      token.span
    )
  }

  private parsePropertyPath(): PropertyPath {
    const first = this.expect("Ident", "property path")
    const segments = [first.value]
    let end = first.span.end
    while (this.peek().kind === "Dot") {
      this.advance()
      const segment = this.expect("Ident", "property name after `.`")
      segments.push(segment.value)
      end = segment.span.end
    }
    return { segments, span: { start: first.span.start, end } }
  }

  // filter := or ; or := and ("or" and)* ; and := atom ("and" atom)*
  private parseFilterExpr(): FilterExpr {
    let left = this.parseFilterAnd()
    while (this.peekKeyword() === "or") {
      this.advance()
      const right = this.parseFilterAnd()
      left = {
        _tag: "Logical",
        op: "or",
        left,
        right,
        span: { start: left.span.start, end: right.span.end }
      }
    }
    return left
  }

  private parseFilterAnd(): FilterExpr {
    let left = this.parseFilterAtom()
    while (this.peekKeyword() === "and") {
      this.advance()
      const right = this.parseFilterAtom()
      left = {
        _tag: "Logical",
        op: "and",
        left,
        right,
        span: { start: left.span.start, end: right.span.end }
      }
    }
    return left
  }

  private parseFilterAtom(): FilterExpr {
    if (this.peek().kind === "LParen") {
      this.advance()
      const expr = this.parseFilterExpr()
      this.expect("RParen", "`)`")
      return expr
    }
    const path = this.parsePropertyPath()
    const opToken = this.expect("Op", "comparison operator")
    if (!(COMPARISON_OPS as ReadonlyArray<string>).includes(opToken.text)) {
      this.fail(`unknown operator \`${opToken.text}\``, opToken.span)
    }
    const value = this.parseLiteral()
    return {
      _tag: "Comparison",
      path,
      op: opToken.text as ComparisonOp,
      value,
      span: { start: path.span.start, end: value.span.end }
    }
  }

  private parseLiteral(): Literal {
    const token = this.peek()
    if (token.kind === "String") {
      this.advance()
      return { _tag: "StringLiteral", value: token.value, span: token.span }
    }
    if (token.kind === "Number") {
      this.advance()
      return { _tag: "NumberLiteral", value: token.value, span: token.span }
    }
    if (token.kind === "Ident" && (token.value === "true" || token.value === "false")) {
      this.advance()
      return { _tag: "BooleanLiteral", value: token.value === "true", span: token.span }
    }
    return this.fail(`expected a literal value, found ${this.describe(token)}`)
  }

  private parseProduct(): Decl {
    const start = this.expectKeyword("product")
    const id = this.expectIdent("product name")
    this.expect("LBrace", "`{`")
    const fields: Array<ProductField> = []
    while (this.peek().kind !== "RBrace" && this.peek().kind !== "EOF") {
      fields.push(this.parseProductField())
    }
    const end = this.expect("RBrace", "`}`")
    return {
      _tag: "ProductDecl",
      id,
      fields,
      span: { start: start.span.start, end: end.span.end }
    }
  }

  private parseProductField(): ProductField {
    const keyword = this.peekKeyword()
    if (keyword === "name") {
      const start = this.advance()
      const value = this.expect("String", "product name string")
      return {
        _tag: "NameField",
        value: value.value,
        span: { start: start.span.start, end: value.span.end }
      }
    }
    if (keyword === "price") {
      const start = this.advance()
      return this.parseRecurringPrice(start)
    }
    if (keyword === "meter") {
      const start = this.advance()
      return this.parseMeterBinding(start)
    }
    return this.fail(
      `expected \`name\`, \`price\` or \`meter\`, found ${this.describe(this.peek())}`
    )
  }

  private parseRecurringPrice(start: Token): ProductField {
    const kind = this.expect("Ident", "`recurring`")
    if (kind.value !== "recurring") {
      this.fail(
        kind.value === "metered"
          ? "`price metered` has been replaced by `meter <id> { ... }` blocks on the product"
          : `expected \`recurring\`, found \`${kind.text}\``,
        kind.span
      )
    }
    const intervalToken = this.expect("Ident", `billing interval (${INTERVALS.join(", ")})`)
    if (!(INTERVALS as ReadonlyArray<string>).includes(intervalToken.value)) {
      this.fail(
        `unknown interval \`${intervalToken.value}\` (expected one of: ${INTERVALS.join(", ")})`,
        intervalToken.span
      )
    }
    const money = this.parseMoney()
    return {
      _tag: "RecurringPriceField",
      interval: intervalToken.value as Interval,
      money,
      span: { start: start.span.start, end: money.currencySpan.end }
    }
  }

  private parseMeterBinding(start: Token): ProductField {
    const meter = this.expectIdent("meter name")
    this.expect("LBrace", "`{`")
    const fields: Array<PricingField> = []
    while (this.peek().kind !== "RBrace" && this.peek().kind !== "EOF") {
      fields.push(this.parsePricingField())
    }
    const end = this.expect("RBrace", "`}`")
    return {
      _tag: "MeterBindingField",
      meter,
      fields,
      span: { start: start.span.start, end: end.span.end }
    }
  }

  private parsePricingField(): PricingField {
    const keyword = this.peekKeyword()
    if (keyword === "per_unit") {
      const start = this.advance()
      const money = this.parseMoney()
      return {
        _tag: "PerUnitField",
        money,
        span: { start: start.span.start, end: money.currencySpan.end }
      }
    }
    if (keyword === "included") {
      const start = this.advance()
      const value = this.expect("Number", "included unit count")
      return {
        _tag: "IncludedField",
        value: value.value,
        span: { start: start.span.start, end: value.span.end }
      }
    }
    return this.fail(
      `expected \`per_unit\` or \`included\`, found ${this.describe(this.peek())}`
    )
  }

  private parseMoney(): Money {
    const amount = this.expect("Number", "amount")
    const currency = this.expect("Ident", "currency code")
    return {
      amount: amount.value,
      amountSpan: amount.span,
      currency: currency.value,
      currencySpan: currency.span
    }
  }
}

export const parse = (tokens: ReadonlyArray<Token>): ParseResult => {
  try {
    const file = new Parser(tokens).parseFile()
    return { file, diagnostics: [] }
  } catch (e) {
    if (e instanceof ParseError) {
      return { file: { decls: [] }, diagnostics: [e.diagnostic] }
    }
    throw e
  }
}

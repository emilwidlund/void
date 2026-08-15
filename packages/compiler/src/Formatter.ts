import type {
  Aggregate,
  Decl,
  EntitlementField,
  FilterExpr,
  InvariantCondition,
  InvariantThreshold,
  Literal,
  MeterField,
  Money,
  OutcomeField,
  PricingField,
  ProductField,
  SourceFile
} from "./Ast.js"
import type { Span } from "./Diagnostic.js"
import type { Comment } from "./Lexer.js"

/**
 * Canonical formatter for `.void` files. Prints from the AST (so output is
 * always grammatically valid), preserves comments by position, keeps blank
 * lines between groups, and normalizes spacing, indentation and number
 * grouping (`10000` -> `10_000`).
 */

const INDENT = "  "
const INLINE_LIMIT = 80

/** Groups integer digits in threes: "10000" -> "10_000". Fractions untouched. */
const formatNumber = (value: string): string => {
  const [int = "", frac] = value.split(".")
  const grouped =
    int.length >= 5 ? int.replace(/\B(?=(\d{3})+(?!\d))/g, "_") : int
  return frac !== undefined ? `${grouped}.${frac}` : grouped
}

const formatString = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`

const formatMoney = (money: Money): string =>
  `${formatNumber(money.amount)} ${money.currency}`

const formatLiteral = (literal: Literal): string => {
  switch (literal._tag) {
    case "StringLiteral":
      return formatString(literal.value)
    case "NumberLiteral":
      return formatNumber(literal.value)
    case "BooleanLiteral":
      return literal.value ? "true" : "false"
  }
}

export const formatFilter = (expr: FilterExpr, parentOp?: "and" | "or"): string => {
  if (expr._tag === "Comparison") {
    return `${expr.path.segments.join(".")} ${expr.op} ${formatLiteral(expr.value)}`
  }
  const rendered = `${formatFilter(expr.left, expr.op)} ${expr.op} ${formatFilter(expr.right, expr.op)}`
  // `and` binds tighter than `or`: an `or` under an `and` needs parentheses.
  return parentOp === "and" && expr.op === "or" ? `(${rendered})` : rendered
}

export const formatAggregate = (aggregate: Aggregate): string =>
  aggregate._tag === "Count"
    ? "count"
    : `${aggregate.fn}(${aggregate.path.segments.join(".")})`

const formatThreshold = (threshold: InvariantThreshold): string => {
  switch (threshold._tag) {
    case "MoneyThreshold":
      return formatMoney(threshold.money)
    case "PercentThreshold":
      return `${formatNumber(threshold.value)}%`
    case "NumberThreshold":
      return formatNumber(threshold.value)
  }
}

const formatCondition = (condition: InvariantCondition): string => {
  const behavior = condition.behavior !== null ? ` else ${condition.behavior.name}` : ""
  return `${condition.metric.name}(${condition.arg.name}) ${condition.op} ${formatThreshold(condition.threshold)}${behavior}`
}

/** Consumes comments by source offset as the printer walks the file. */
class CommentPool {
  private index = 0
  constructor(private readonly comments: ReadonlyArray<Comment>) {}

  /** Consume comments starting before `offset`. */
  take(offset: number): ReadonlyArray<Comment> {
    const taken: Array<Comment> = []
    while (
      this.index < this.comments.length &&
      this.comments[this.index]!.span.start.offset < offset
    ) {
      taken.push(this.comments[this.index]!)
      this.index += 1
    }
    return taken
  }

  /** Consume a comment sitting on `line` (a trailing comment), if any. */
  takeOnLine(line: number): Comment | undefined {
    const next = this.comments[this.index]
    if (next !== undefined && next.span.start.line === line) {
      this.index += 1
      return next
    }
    return undefined
  }

  hasAnyBefore(offset: number): boolean {
    const next = this.comments[this.index]
    return next !== undefined && next.span.start.offset < offset
  }
}

/** One printable unit: a field or declaration with its source span. */
interface Item {
  readonly span: Span
  readonly print: (indent: string, pool: CommentPool, out: Lines) => void
}

class Lines {
  readonly lines: Array<string> = []
  lastEndedLine = 0

  push(text: string, endedLine: number) {
    this.lines.push(text)
    this.lastEndedLine = endedLine
  }

  appendToLast(text: string) {
    const last = this.lines.length - 1
    if (last >= 0) this.lines[last] = `${this.lines[last]}${text}`
  }

  blank() {
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== "") {
      this.lines.push("")
    }
  }
}

const emitItems = (
  items: ReadonlyArray<Item>,
  indent: string,
  pool: CommentPool,
  out: Lines,
  endOffset: number
) => {
  for (const item of items) {
    for (const comment of pool.take(item.span.start.offset)) {
      if (comment.span.start.line - out.lastEndedLine > 1) out.blank()
      out.push(`${indent}${comment.text}`, comment.span.end.line)
    }
    if (item.span.start.line - out.lastEndedLine > 1) out.blank()
    item.print(indent, pool, out)
    const trailing = pool.takeOnLine(item.span.end.line)
    if (trailing !== undefined) out.appendToLast(`  ${trailing.text}`)
  }
  for (const comment of pool.take(endOffset)) {
    if (comment.span.start.line - out.lastEndedLine > 1) out.blank()
    out.push(`${indent}${comment.text}`, comment.span.end.line)
  }
}

/** Prints `header { fields }`, inlining single-field blocks without comments. */
const emitBlock = (
  header: string,
  fields: ReadonlyArray<Item>,
  span: Span,
  indent: string,
  pool: CommentPool,
  out: Lines
) => {
  if (fields.length === 1 && !pool.hasAnyBefore(span.end.offset)) {
    const inner = new Lines()
    fields[0]!.print("", new CommentPool([]), inner)
    if (inner.lines.length === 1) {
      const line = `${indent}${header} { ${inner.lines[0]} }`
      if (line.length <= INLINE_LIMIT) {
        out.push(line, span.end.line)
        return
      }
    }
  }
  out.push(`${indent}${header} {`, span.start.line)
  emitItems(fields, `${indent}${INDENT}`, pool, out, span.end.offset)
  out.push(`${indent}}`, span.end.line)
}

const line = (span: Span, text: (indent: string) => string): Item => ({
  span,
  print: (indent, _pool, out) => out.push(`${indent}${text(indent)}`, span.end.line)
})

const meterFieldItem = (field: MeterField): Item => {
  switch (field._tag) {
    case "FilterField":
      return line(field.span, () => `filter ${formatFilter(field.expr)}`)
    case "AggregateField":
      return line(field.span, () => `aggregate ${formatAggregate(field.aggregate)}`)
    case "UnitField":
      return line(field.span, () => `unit ${field.name.name}`)
    case "ReverseField": {
      const window =
        field.window !== null
          ? ` within ${formatNumber(field.window.value)} ${field.window.unit.name}`
          : ""
      return line(field.span, () => `reverse_on ${formatFilter(field.expr)}${window}`)
    }
  }
}

const pricingFieldItem = (field: PricingField): Item => {
  switch (field._tag) {
    case "PerUnitField": {
      const per = field.per !== null ? ` per ${field.per.name}` : ""
      return line(field.span, () => `per_unit ${formatMoney(field.money)}${per}`)
    }
    case "IncludedField":
      return line(field.span, () => `included ${formatNumber(field.value)}`)
    case "MarginField":
      return line(field.span, () => `margin ${formatNumber(field.value)}%`)
  }
}

const entitlementFieldItem = (field: EntitlementField): Item => {
  switch (field._tag) {
    case "LimitField":
      return line(field.span, () => `limit ${formatNumber(field.value)}`)
    case "EntitlementMeterField":
      return line(field.span, () => `meter ${field.meter.name}`)
  }
}

const productFieldItem = (field: ProductField): Item => {
  switch (field._tag) {
    case "NameField":
      return line(field.span, () => `name ${formatString(field.value)}`)
    case "RecurringPriceField":
      return line(
        field.span,
        () => `price recurring ${field.interval} ${formatMoney(field.money)}`
      )
    case "MeterBindingField":
      return {
        span: field.span,
        print: (indent, pool, out) =>
          emitBlock(
            `${field.kind} ${field.meter.name}`,
            field.fields.map(pricingFieldItem),
            field.span,
            indent,
            pool,
            out
          )
      }
    case "EntitlementField":
      return {
        span: field.span,
        print: (indent, pool, out) => {
          if (field.fields.length === 0) {
            out.push(`${indent}entitlement ${field.id.name}`, field.span.end.line)
            return
          }
          emitBlock(
            `entitlement ${field.id.name}`,
            field.fields.map(entitlementFieldItem),
            field.span,
            indent,
            pool,
            out
          )
        }
      }
  }
}

const outcomeFieldItem = (field: OutcomeField): Item => {
  switch (field._tag) {
    case "CorrelateField":
      return line(field.span, () => `correlate ${field.path.segments.join(".")}`)
    case "StepField":
      return line(field.span, () => `step ${formatFilter(field.expr)}`)
    case "FailField": {
      const window =
        field.window !== null
          ? ` within ${formatNumber(field.window.value)} ${field.window.unit.name}`
          : ""
      return line(field.span, () => `fail_on ${formatFilter(field.expr)}${window}`)
    }
  }
}

const declItem = (decl: Decl): Item => {
  switch (decl._tag) {
    case "MeterDecl":
      return {
        span: decl.span,
        print: (indent, pool, out) =>
          emitBlock(
            `meter ${decl.id.name}`,
            decl.fields.map(meterFieldItem),
            decl.span,
            indent,
            pool,
            out
          )
      }
    case "ProductDecl":
      return {
        span: decl.span,
        print: (indent, pool, out) =>
          emitBlock(
            `product ${decl.id.name}`,
            decl.fields.map(productFieldItem),
            decl.span,
            indent,
            pool,
            out
          )
      }
    case "InvariantDecl":
      return {
        span: decl.span,
        print: (indent, pool, out) =>
          emitBlock(
            `invariant ${formatString(decl.name)}`,
            decl.conditions.map((condition) =>
              line(condition.span, () => formatCondition(condition))
            ),
            decl.span,
            indent,
            pool,
            out
          )
      }
    case "OutcomeDecl":
      return {
        span: decl.span,
        print: (indent, pool, out) =>
          emitBlock(
            `outcome ${decl.id.name}`,
            decl.fields.map(outcomeFieldItem),
            decl.span,
            indent,
            pool,
            out
          )
      }
    case "OverrideDecl": {
      const items: Array<Item> = decl.fields.map(productFieldItem)
      if (decl.until !== null) {
        const until = decl.until
        items.push(line(until.span, () => `until ${formatString(until.value)}`))
      }
      items.sort((a, b) => a.span.start.offset - b.span.start.offset)
      return {
        span: decl.span,
        print: (indent, pool, out) =>
          emitBlock(
            `override customer ${formatString(decl.customer)}`,
            items,
            decl.span,
            indent,
            pool,
            out
          )
      }
    }
  }
}

export const formatSource = (
  file: SourceFile,
  comments: ReadonlyArray<Comment> = []
): string => {
  const pool = new CommentPool(comments)
  const out = new Lines()

  let previousWasDecl = false
  for (const decl of file.decls) {
    const item = declItem(decl)
    const leading = pool.take(item.span.start.offset)
    if (out.lines.length > 0 && (leading.length > 0 || previousWasDecl)) out.blank()
    for (const comment of leading) {
      if (comment.span.start.line - out.lastEndedLine > 1 && out.lines.length > 0) {
        out.blank()
      }
      out.push(comment.text, comment.span.end.line)
    }
    if (
      out.lines.length > 0 &&
      leading.length > 0 &&
      item.span.start.line - out.lastEndedLine > 1
    ) {
      out.blank()
    }
    item.print("", pool, out)
    const trailing = pool.takeOnLine(item.span.end.line)
    if (trailing !== undefined) out.appendToLast(`  ${trailing.text}`)
    previousWasDecl = true
  }
  for (const comment of pool.take(Number.MAX_SAFE_INTEGER)) {
    if (comment.span.start.line - out.lastEndedLine > 1) out.blank()
    out.push(comment.text, comment.span.end.line)
  }

  return out.lines.join("\n") + (out.lines.length > 0 ? "\n" : "")
}

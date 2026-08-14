import type {
  Diagnostic,
  Identifier,
  MeterDecl,
  SourceFile,
  Span
} from "@void/compiler"
import {
  check,
  formatAggregate,
  formatFilter,
  hasErrors,
  KNOWN_UNIT_NAMES,
  parse,
  tokenize
} from "@void/compiler"

/**
 * Pure language-service logic, kept transport-free so it can be unit-tested.
 * `Server.ts` wires these functions to an LSP connection.
 */

/** LSP positions are 0-based; compiler spans are 1-based. */
export interface Position {
  readonly line: number
  readonly character: number
}

export interface Range {
  readonly start: Position
  readonly end: Position
}

export const toRange = (span: Span): Range => ({
  start: { line: span.start.line - 1, character: span.start.column - 1 },
  end: { line: span.end.line - 1, character: span.end.column - 1 }
})

export interface FileDiagnostic {
  readonly range: Range
  /** 1 = error, 2 = warning (LSP DiagnosticSeverity) */
  readonly severity: 1 | 2
  readonly code: string
  readonly message: string
  readonly source: "void"
}

/** Lex + parse + check, accumulating every diagnostic the pipeline produces. */
export const computeDiagnostics = (source: string): ReadonlyArray<FileDiagnostic> => {
  const all: Array<Diagnostic> = []
  const lexed = tokenize(source)
  all.push(...lexed.diagnostics)
  const parsed = parse(lexed.tokens)
  all.push(...parsed.diagnostics)
  if (!hasErrors(lexed.diagnostics) && !hasErrors(parsed.diagnostics)) {
    all.push(...check(parsed.file))
  }
  return all.map((diagnostic) => ({
    range: toRange(diagnostic.span),
    severity: diagnostic.severity === "error" ? 1 : 2,
    code: diagnostic.code,
    message: diagnostic.message,
    source: "void"
  }))
}

const parseFile = (source: string): SourceFile | null => {
  const lexed = tokenize(source)
  if (hasErrors(lexed.diagnostics)) return null
  const parsed = parse(lexed.tokens)
  return hasErrors(parsed.diagnostics) ? null : parsed.file
}

const contains = (span: Span, offset: number): boolean =>
  span.start.offset <= offset && offset <= span.end.offset

/** Every identifier that references a top-level meter, wherever it appears. */
const meterReferences = (file: SourceFile): ReadonlyArray<Identifier> => {
  const refs: Array<Identifier> = []
  for (const decl of file.decls) {
    if (decl._tag === "ProductDecl") {
      for (const field of decl.fields) {
        if (field._tag === "MeterBindingField") refs.push(field.meter)
        if (field._tag === "EntitlementField") {
          for (const inner of field.fields) {
            if (inner._tag === "EntitlementMeterField") refs.push(inner.meter)
          }
        }
      }
    }
    if (decl._tag === "InvariantDecl") {
      for (const condition of decl.conditions) {
        if (condition.arg.name !== "customer") refs.push(condition.arg)
      }
    }
  }
  return refs
}

const meterDecls = (file: SourceFile): ReadonlyArray<MeterDecl> =>
  file.decls.filter((d): d is MeterDecl => d._tag === "MeterDecl")

const meterAt = (source: string, offset: number): MeterDecl | null => {
  const file = parseFile(source)
  if (file === null) return null
  const decls = meterDecls(file)
  const reference = meterReferences(file).find((ref) => contains(ref.span, offset))
  const name =
    reference?.name ??
    decls.find((decl) => contains(decl.id.span, offset))?.id.name ??
    null
  if (name === null) return null
  return decls.find((decl) => decl.id.name === name) ?? null
}

/** Go-to-definition: a meter reference resolves to its declaration's id. */
export const definitionAt = (source: string, offset: number): Range | null => {
  const meter = meterAt(source, offset)
  return meter === null ? null : toRange(meter.id.span)
}

/** Hover on a meter reference or declaration: a markdown summary. */
export const hoverAt = (source: string, offset: number): string | null => {
  const meter = meterAt(source, offset)
  if (meter === null) return null
  const lines = [`\`\`\`void\nmeter ${meter.id.name}\n\`\`\``]
  for (const field of meter.fields) {
    if (field._tag === "FilterField") lines.push(`filter: \`${formatFilter(field.expr)}\``)
    if (field._tag === "AggregateField") {
      lines.push(`aggregate: \`${formatAggregate(field.aggregate)}\``)
    }
    if (field._tag === "UnitField") lines.push(`unit: \`${field.name.name}\``)
  }
  return lines.join("\n\n")
}

export interface Completion {
  readonly label: string
  /** LSP CompletionItemKind: 14 = keyword, 3 = function, 6 = variable, 24 = operator */
  readonly kind: 14 | 3 | 6 | 24
  readonly detail?: string
}

const keyword = (label: string): Completion => ({ label, kind: 14 })
const fn = (label: string): Completion => ({ label, kind: 3 })

/** Blanks out strings and comments so brace-scanning can't be fooled. */
const sanitize = (source: string): string =>
  source
    .replace(/"(?:[^"\\\n]|\\.)*("|$)/gm, (match) => " ".repeat(match.length))
    .replace(/#[^\n]*/g, (match) => " ".repeat(match.length))

/**
 * The stack of enclosing block headers at `offset` — e.g. inside a meter
 * binding within a product it is ["product", "meter"].
 */
export const blockContext = (source: string, offset: number): ReadonlyArray<string> => {
  const text = sanitize(source)
  const stack: Array<string> = []
  for (let i = 0; i < Math.min(offset, text.length); i += 1) {
    const ch = text[i]
    if (ch === "}") {
      stack.pop()
    } else if (ch === "{") {
      const lineStart = text.lastIndexOf("\n", i - 1) + 1
      const header = text.slice(lineStart, i).trim().split(/\s+/)[0] ?? ""
      stack.push(header)
    }
  }
  return stack
}

/** Top-level meter names, by parse when possible and by regex while typing. */
export const knownMeters = (source: string): ReadonlyArray<string> => {
  const file = parseFile(source)
  if (file !== null) return meterDecls(file).map((decl) => decl.id.name)
  const names: Array<string> = []
  for (const match of source.matchAll(/^meter\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    names.push(match[1]!)
  }
  return names
}

const UNIT_ITEMS: ReadonlyArray<Completion> = KNOWN_UNIT_NAMES.map((name) => ({
  label: name,
  kind: 6,
  detail: "unit"
}))

const CURRENCY_ITEMS: ReadonlyArray<Completion> = [
  "USD",
  "USD_CENTS",
  "EUR",
  "EUR_CENTS",
  "GBP",
  "GBP_CENTS"
].map((name) => ({ label: name, kind: 6, detail: "currency" }))

const BEHAVIOR_ITEMS: ReadonlyArray<Completion> = ["warn", "cap", "block", "notify"].map(
  keyword
)

const INTERVAL_ITEMS: ReadonlyArray<Completion> = [
  "monthly",
  "yearly",
  "weekly",
  "daily"
].map(keyword)

const AGGREGATE_ITEMS: ReadonlyArray<Completion> = [
  fn("count"),
  fn("sum"),
  fn("max"),
  fn("min"),
  fn("avg"),
  fn("unique")
]

const NUMBER_PATTERN = /^\d[\d_]*(\.\d[\d_]*)?$/
const CURRENCY_PATTERN = /^[A-Z]{3}(_CENTS)?$/
const EVENT_PATH_PATTERN = /^event(\.[A-Za-z_][A-Za-z0-9_]*)*$/
const METRIC_CALL_PATTERN = /^(price|margin|spend)\([A-Za-z_][A-Za-z0-9_]*\)$/
const INTERVALS = ["monthly", "yearly", "weekly", "daily"]

const OPERATOR_ITEMS: ReadonlyArray<Completion> = ["==", "!=", ">=", "<=", ">", "<"].map(
  (op) => ({ label: op, kind: 24 })
)

const LOGICAL_ITEMS: ReadonlyArray<Completion> = [keyword("and"), keyword("or")]

const EVENT_ITEM: Completion = { label: "event", kind: 6, detail: "ingested event" }

/** A finished comparison operand: string, number, percent or boolean. */
const isLiteral = (word: string): boolean =>
  /^".*"$/.test(word) ||
  NUMBER_PATTERN.test(word) ||
  /%$/.test(word) ||
  word === "true" ||
  word === "false"

export const completionsAt = (
  source: string,
  offset: number
): ReadonlyArray<Completion> => {
  const context = blockContext(source, offset)
  const meters = knownMeters(source).map(
    (name): Completion => ({ label: name, kind: 6, detail: "meter" })
  )

  // Value-position completion: look at the words already typed on this line
  // (after the last brace, with the partial word under the cursor dropped).
  // Context (braces, metric calls) is read from the sanitized text so string
  // contents can't confuse it; the words come from the raw line so literals
  // like "api.request" stay visible.
  const sanitized = sanitize(source)
  const lineStart = sanitized.lastIndexOf("\n", offset - 1) + 1
  let sanitizedLine = sanitized.slice(lineStart, offset)
  const braceIndex = Math.max(
    sanitizedLine.lastIndexOf("{"),
    sanitizedLine.lastIndexOf("}")
  )
  let rawLine = source.slice(lineStart, offset)
  if (braceIndex >= 0) {
    sanitizedLine = sanitizedLine.slice(braceIndex + 1)
    rawLine = rawLine.slice(braceIndex + 1)
  }

  // `spend(`, `margin(`, `price(` — complete the metric's subject.
  const call = /\b(price|margin|spend)\(\s*[A-Za-z_]*$/.exec(sanitizedLine)
  if (call !== null && context[0] === "invariant") {
    if (call[1] === "spend") return [{ label: "customer", kind: 6 }]
    if (call[1] === "margin") return [{ label: "customer", kind: 6 }, ...meters]
    return meters
  }
  // `sum(`, `avg(`, ... — aggregations read event properties.
  if (/\b(sum|max|min|avg|unique)\(\s*[A-Za-z_]*$/.test(sanitizedLine)) {
    return [EVENT_ITEM]
  }

  const endsMidWord = /[A-Za-z0-9_"]$/.test(rawLine)
  const words = rawLine.trim().length > 0 ? rawLine.trim().split(/\s+/) : []
  const typed = endsMidWord ? words.slice(0, -1) : words
  const field = typed[0]
  const last = typed[typed.length - 1]

  if (typed.length > 0 && field !== undefined && last !== undefined) {
    // Field-value slots.
    if (last === "per") return UNIT_ITEMS
    if (last === "else") return BEHAVIOR_ITEMS
    if (field === "unit") return typed.length === 1 ? UNIT_ITEMS : []
    if (field === "aggregate") return typed.length === 1 ? AGGREGATE_ITEMS : []
    if (field === "meter") {
      return typed.length === 1 && context.length > 0 ? meters : []
    }
    if (field === "price") {
      if (!typed.includes("recurring")) {
        return typed.length === 1 ? [keyword("recurring")] : []
      }
      if (last === "recurring") return INTERVAL_ITEMS
      if (NUMBER_PATTERN.test(last)) return CURRENCY_ITEMS
      return []
    }
    if (field === "per_unit") {
      if (NUMBER_PATTERN.test(last)) return CURRENCY_ITEMS
      if (CURRENCY_PATTERN.test(last)) return [keyword("per")]
      return []
    }
    // Filter expressions: path -> operator -> literal -> and/or -> path ...
    if (field === "filter") {
      if (last === "filter" || last === "and" || last === "or") return [EVENT_ITEM]
      if (EVENT_PATH_PATTERN.test(last.replace(/^\(+/, ""))) return OPERATOR_ITEMS
      if (isLiteral(last.replace(/\)+$/, "")) || /\)$/.test(last)) return LOGICAL_ITEMS
      return []
    }
    // Invariant conditions: metric(subject) -> operator -> threshold -> else.
    if (context[0] === "invariant") {
      if (METRIC_CALL_PATTERN.test(last)) return OPERATOR_ITEMS
      if (CURRENCY_PATTERN.test(last) || /%$/.test(last)) return [keyword("else")]
      if (NUMBER_PATTERN.test(last) && !sanitizedLine.includes("margin(")) {
        return CURRENCY_ITEMS // margin thresholds are percentages
      }
      return []
    }
    // Product price line already complete, interval amounts, etc.
    if (field === "recurring" && INTERVALS.includes(last)) return []
    return []
  }

  if (context.length === 0) {
    return [keyword("meter"), keyword("product"), keyword("invariant")]
  }
  const top = context[0]
  const inner = context[context.length - 1]

  if (top === "meter" && context.length === 1) {
    return [keyword("filter"), keyword("aggregate"), keyword("unit"), ...AGGREGATE_ITEMS]
  }
  if (top === "invariant") {
    return [
      fn("price"),
      fn("margin"),
      fn("spend"),
      { label: "customer", kind: 6 },
      keyword("else"),
      ...BEHAVIOR_ITEMS,
      ...meters
    ]
  }
  if (top === "product") {
    if (inner === "meter") {
      return [keyword("per_unit"), keyword("included"), keyword("margin"), keyword("per")]
    }
    if (inner === "entitlement") {
      return [keyword("limit"), keyword("meter"), ...meters]
    }
    return [
      keyword("name"),
      keyword("price"),
      keyword("recurring"),
      ...INTERVAL_ITEMS,
      keyword("entitlement"),
      keyword("meter"),
      ...meters
    ]
  }
  return []
}

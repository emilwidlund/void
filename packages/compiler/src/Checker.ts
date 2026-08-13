import type { FilterExpr, MeterDecl, Money, ProductDecl, SourceFile } from "./Ast.js"
import type { Diagnostic } from "./Diagnostic.js"
import * as D from "./Diagnostic.js"

const CURRENCY_PATTERN = /^[A-Z]{3}(_CENTS)?$/

const checkMoney = (money: Money, diagnostics: Array<Diagnostic>) => {
  if (!CURRENCY_PATTERN.test(money.currency)) {
    diagnostics.push(
      D.error(
        "VOID105",
        `invalid currency \`${money.currency}\` (expected an ISO code like USD, or USD_CENTS for minor units)`,
        money.currencySpan
      )
    )
  }
}

const checkFilter = (expr: FilterExpr, diagnostics: Array<Diagnostic>) => {
  if (expr._tag === "Logical") {
    checkFilter(expr.left, diagnostics)
    checkFilter(expr.right, diagnostics)
    return
  }
  if (expr.path.segments[0] !== "event") {
    diagnostics.push(
      D.warning(
        "VOID108",
        `filter property \`${expr.path.segments.join(".")}\` does not start with \`event.\` — it will never match`,
        expr.path.span
      )
    )
  }
}

const checkMeter = (meter: MeterDecl, diagnostics: Array<Diagnostic>) => {
  const filters = meter.fields.filter((f) => f._tag === "FilterField")
  const aggregates = meter.fields.filter((f) => f._tag === "AggregateField")

  if (aggregates.length === 0) {
    diagnostics.push(
      D.error("VOID102", `meter \`${meter.id.name}\` is missing an \`aggregate\``, meter.id.span)
    )
  }
  for (const extra of aggregates.slice(1)) {
    diagnostics.push(D.error("VOID103", "duplicate `aggregate` field", extra.span))
  }
  for (const extra of filters.slice(1)) {
    diagnostics.push(D.error("VOID103", "duplicate `filter` field", extra.span))
  }
  for (const field of filters) {
    if (field._tag === "FilterField") checkFilter(field.expr, diagnostics)
  }
}

const checkProduct = (
  product: ProductDecl,
  meterIds: ReadonlySet<string>,
  diagnostics: Array<Diagnostic>
) => {
  const names = product.fields.filter((f) => f._tag === "NameField")
  if (names.length === 0) {
    diagnostics.push(
      D.error("VOID104", `product \`${product.id.name}\` is missing a \`name\``, product.id.span)
    )
  }
  for (const extra of names.slice(1)) {
    diagnostics.push(D.error("VOID103", "duplicate `name` field", extra.span))
  }

  const prices = product.fields.filter((f) => f._tag === "PriceField")
  if (prices.length === 0) {
    diagnostics.push(
      D.warning("VOID110", `product \`${product.id.name}\` has no prices`, product.id.span)
    )
  }

  for (const field of prices) {
    if (field._tag !== "PriceField") continue
    const price = field.price
    if (price._tag === "RecurringPrice") {
      checkMoney(price.money, diagnostics)
      continue
    }
    if (!meterIds.has(price.meter.name)) {
      diagnostics.push(
        D.error(
          "VOID101",
          `unknown meter \`${price.meter.name}\` referenced by metered price`,
          price.meter.span
        )
      )
    }
    const perUnits = price.fields.filter((f) => f._tag === "PerUnitField")
    const includeds = price.fields.filter((f) => f._tag === "IncludedField")
    if (perUnits.length === 0) {
      diagnostics.push(D.error("VOID109", "metered price is missing `per_unit`", price.span))
    }
    for (const extra of perUnits.slice(1)) {
      diagnostics.push(D.error("VOID103", "duplicate `per_unit` field", extra.span))
    }
    for (const extra of includeds.slice(1)) {
      diagnostics.push(D.error("VOID103", "duplicate `included` field", extra.span))
    }
    for (const perUnit of perUnits) {
      if (perUnit._tag === "PerUnitField") checkMoney(perUnit.money, diagnostics)
    }
    for (const included of includeds) {
      if (included._tag === "IncludedField" && included.value.includes(".")) {
        diagnostics.push(
          D.error("VOID107", "`included` must be a whole number of units", included.span)
        )
      }
    }
  }
}

export const check = (file: SourceFile): ReadonlyArray<Diagnostic> => {
  const diagnostics: Array<Diagnostic> = []

  const seen = new Map<string, string>()
  for (const decl of file.decls) {
    const kind = decl._tag === "MeterDecl" ? "meter" : "product"
    const previous = seen.get(decl.id.name)
    if (previous !== undefined) {
      diagnostics.push(
        D.error(
          "VOID100",
          `duplicate declaration \`${decl.id.name}\` (previously declared as a ${previous})`,
          decl.id.span
        )
      )
    } else {
      seen.set(decl.id.name, kind)
    }
  }

  const meterIds = new Set(
    file.decls.filter((d): d is MeterDecl => d._tag === "MeterDecl").map((d) => d.id.name)
  )

  for (const decl of file.decls) {
    if (decl._tag === "MeterDecl") checkMeter(decl, diagnostics)
    else checkProduct(decl, meterIds, diagnostics)
  }

  return diagnostics
}

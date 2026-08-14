import type {
  FilterExpr,
  InvariantDecl,
  MeterDecl,
  MeterField,
  Money,
  ProductDecl,
  ProductField,
  SourceFile
} from "./Ast.js"
import type { Diagnostic } from "./Diagnostic.js"
import * as D from "./Diagnostic.js"
import { toIrMoney } from "./Ir.js"
import { resolveUnit } from "./Units.js"

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
  const units = meter.fields.filter((f) => f._tag === "UnitField")

  for (const extra of units.slice(1)) {
    diagnostics.push(D.error("VOID103", "duplicate `unit` field", extra.span))
  }

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
  meterUnits: ReadonlyMap<string, string>,
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

  const prices = product.fields.filter(
    (f) => f._tag === "RecurringPriceField" || f._tag === "MeterBindingField"
  )
  if (prices.length === 0) {
    diagnostics.push(
      D.warning("VOID110", `product \`${product.id.name}\` has no prices`, product.id.span)
    )
  }

  for (const price of prices) {
    if (price._tag === "RecurringPriceField") {
      checkMoney(price.money, diagnostics)
      continue
    }
    if (price._tag !== "MeterBindingField") continue
    if (!meterIds.has(price.meter.name)) {
      diagnostics.push(
        D.error(
          "VOID101",
          `unknown meter \`${price.meter.name}\` (meters must be declared at the top level)`,
          price.meter.span
        )
      )
    }
    const perUnits = price.fields.filter((f) => f._tag === "PerUnitField")
    const includeds = price.fields.filter((f) => f._tag === "IncludedField")
    const margins = price.fields.filter((f) => f._tag === "MarginField")
    if (perUnits.length === 0 && margins.length === 0) {
      diagnostics.push(
        D.error("VOID109", "meter binding is missing `per_unit` or `margin`", price.span)
      )
    }
    if (perUnits.length > 0 && margins.length > 0) {
      diagnostics.push(
        D.error(
          "VOID117",
          "specify either `per_unit` or `margin`, not both — a margin price is derived from reported costs",
          price.span
        )
      )
    }
    if (margins.length > 0 && includeds.length > 0) {
      diagnostics.push(
        D.error(
          "VOID119",
          "`included` cannot be combined with `margin` pricing — allowances apply to unit prices",
          price.span
        )
      )
    }
    for (const extra of perUnits.slice(1)) {
      diagnostics.push(D.error("VOID103", "duplicate `per_unit` field", extra.span))
    }
    for (const extra of includeds.slice(1)) {
      diagnostics.push(D.error("VOID103", "duplicate `included` field", extra.span))
    }
    for (const extra of margins.slice(1)) {
      diagnostics.push(D.error("VOID103", "duplicate `margin` field", extra.span))
    }
    for (const margin of margins) {
      if (margin._tag !== "MarginField") continue
      const value = Number(margin.value)
      if (!(value > 0 && value < 100)) {
        diagnostics.push(
          D.error(
            "VOID118",
            "`margin` must be between 0% and 100% (exclusive)",
            margin.span
          )
        )
      }
    }
    for (const perUnit of perUnits) {
      if (perUnit._tag !== "PerUnitField") continue
      checkMoney(perUnit.money, diagnostics)
      if (perUnit.per === null) continue
      const priced = resolveUnit(perUnit.per.name)
      const declared = meterUnits.get(price.meter.name)
      if (declared === undefined) {
        if (meterIds.has(price.meter.name)) {
          diagnostics.push(
            D.warning(
              "VOID121",
              `price is per \`${priced.canonical}\` but meter \`${price.meter.name}\` declares no \`unit\` — the conversion cannot be checked`,
              perUnit.per.span
            )
          )
        }
        continue
      }
      const meterUnit = resolveUnit(declared)
      if (meterUnit.dimension !== priced.dimension) {
        diagnostics.push(
          D.error(
            "VOID120",
            `meter \`${price.meter.name}\` aggregates \`${meterUnit.canonical}\` but the price is per \`${priced.canonical}\` — these units are not convertible`,
            perUnit.per.span
          )
        )
      }
    }
    for (const included of includeds) {
      if (included._tag === "IncludedField" && included.value.includes(".")) {
        diagnostics.push(
          D.error("VOID107", "`included` must be a whole number of units", included.span)
        )
      }
    }
  }

  const entitlements = product.fields.filter(
    (f): f is Extract<ProductField, { _tag: "EntitlementField" }> =>
      f._tag === "EntitlementField"
  )
  const entitlementIds = new Set<string>()
  for (const entitlement of entitlements) {
    if (entitlementIds.has(entitlement.id.name)) {
      diagnostics.push(
        D.error(
          "VOID111",
          `duplicate entitlement \`${entitlement.id.name}\` in product \`${product.id.name}\``,
          entitlement.id.span
        )
      )
    }
    entitlementIds.add(entitlement.id.name)

    const limits = entitlement.fields.filter((f) => f._tag === "LimitField")
    const meters = entitlement.fields.filter((f) => f._tag === "EntitlementMeterField")
    for (const extra of limits.slice(1)) {
      diagnostics.push(D.error("VOID103", "duplicate `limit` field", extra.span))
    }
    for (const extra of meters.slice(1)) {
      diagnostics.push(D.error("VOID103", "duplicate `meter` field", extra.span))
    }
    // A block form exists to bound something; a bare `entitlement <id>` is the flag form.
    if (entitlement.fields.length > 0 && limits.length === 0) {
      diagnostics.push(
        D.error(
          "VOID112",
          `entitlement \`${entitlement.id.name}\` has a block but no \`limit\` (drop the block for a boolean grant)`,
          entitlement.span
        )
      )
    }
    for (const meter of meters) {
      if (meter._tag === "EntitlementMeterField" && !meterIds.has(meter.meter.name)) {
        diagnostics.push(
          D.error(
            "VOID101",
            `unknown meter \`${meter.meter.name}\` (meters must be declared at the top level)`,
            meter.meter.span
          )
        )
      }
    }
  }
}

const INVARIANT_METRICS = ["price", "margin", "spend"] as const
const INVARIANT_BEHAVIORS = ["warn", "cap", "block", "notify"] as const

const compare = (left: number, op: string, right: number): boolean => {
  switch (op) {
    case "==":
      return left === right
    case "!=":
      return left !== right
    case ">":
      return left > right
    case ">=":
      return left >= right
    case "<":
      return left < right
    default:
      return op === "<=" ? left <= right : false
  }
}

const checkInvariant = (
  invariant: InvariantDecl,
  meterIds: ReadonlySet<string>,
  products: ReadonlyArray<ProductDecl>,
  diagnostics: Array<Diagnostic>
) => {
  for (const condition of invariant.conditions) {
    const metric = condition.metric.name
    if (!(INVARIANT_METRICS as ReadonlyArray<string>).includes(metric)) {
      diagnostics.push(
        D.error(
          "VOID130",
          `unknown metric \`${metric}\` (expected one of: ${INVARIANT_METRICS.join(", ")})`,
          condition.metric.span
        )
      )
      continue
    }
    const overCustomers = condition.arg.name === "customer"

    if (metric === "spend" && !overCustomers) {
      diagnostics.push(
        D.error(
          "VOID131",
          "`spend` is a runtime metric over customers — write `spend(customer)`",
          condition.arg.span
        )
      )
      continue
    }
    if (metric === "price" && overCustomers) {
      diagnostics.push(
        D.error("VOID131", "`price` applies to a meter, not `customer`", condition.arg.span)
      )
      continue
    }
    if (!overCustomers && !meterIds.has(condition.arg.name)) {
      diagnostics.push(
        D.error(
          "VOID101",
          `unknown meter \`${condition.arg.name}\` (meters must be declared at the top level)`,
          condition.arg.span
        )
      )
      continue
    }

    // Behavior validity matrix: statically-proven invariants can only soften
    // to a warning; runtime remedies only exist where void (or the app via
    // the entitlements endpoint) can actually execute them.
    if (condition.behavior !== null) {
      const behavior = condition.behavior.name
      if (!(INVARIANT_BEHAVIORS as ReadonlyArray<string>).includes(behavior)) {
        diagnostics.push(
          D.error(
            "VOID136",
            `unknown behavior \`${behavior}\` (expected one of: ${INVARIANT_BEHAVIORS.join(", ")})`,
            condition.behavior.span
          )
        )
      } else {
        const allowed = overCustomers
          ? metric === "spend"
            ? ["warn", "cap", "block", "notify"]
            : ["warn", "notify"] // margin(customer): can't cap or block your own costs
          : ["warn"] // compile-checked invariants have no runtime to remedy
        if (!allowed.includes(behavior)) {
          diagnostics.push(
            D.error(
              "VOID137",
              `\`${metric}(${condition.arg.name})\` cannot use \`else ${behavior}\` (allowed: ${allowed.join(", ")})`,
              condition.behavior.span
            )
          )
        }
      }
    }

    // Threshold shape: price/spend compare money, margin compares a percentage.
    const wantsMoney = metric === "price" || metric === "spend"
    if (wantsMoney && condition.threshold._tag !== "MoneyThreshold") {
      diagnostics.push(
        D.error(
          "VOID132",
          `\`${metric}\` compares against a money amount, like \`5 USD_CENTS\``,
          condition.span
        )
      )
      continue
    }
    if (!wantsMoney && condition.threshold._tag !== "PercentThreshold") {
      diagnostics.push(
        D.error(
          "VOID132",
          "`margin` compares against a percentage, like `40%`",
          condition.span
        )
      )
      continue
    }
    if (condition.threshold._tag === "MoneyThreshold") {
      checkMoney(condition.threshold.money, diagnostics)
    }

    if (overCustomers) continue // runtime-monitored; nothing to prove statically

    // `else warn` softens a static violation from build-breaking to advisory.
    const report = condition.behavior?.name === "warn" ? D.warning : D.error

    // Static evaluation over every product that prices this meter.
    const meterId = condition.arg.name
    for (const product of products) {
      for (const field of product.fields) {
        if (field._tag !== "MeterBindingField" || field.meter.name !== meterId) continue
        if (metric === "price" && condition.threshold._tag === "MoneyThreshold") {
          const threshold = toIrMoney(condition.threshold.money)
          for (const pricing of field.fields) {
            if (pricing._tag !== "PerUnitField") continue
            const perUnit = toIrMoney(pricing.money)
            if (perUnit.currency !== threshold.currency) {
              diagnostics.push(
                D.error(
                  "VOID135",
                  `invariant \`${invariant.name}\` compares ${threshold.currency} but product \`${product.id.name}\` prices \`${meterId}\` in ${perUnit.currency}`,
                  pricing.span
                )
              )
              continue
            }
            if (!compare(Number(perUnit.amount), condition.op, Number(threshold.amount))) {
              diagnostics.push(
                report(
                  "VOID133",
                  `invariant \`${invariant.name}\` violated: product \`${product.id.name}\` prices \`${meterId}\` at ${perUnit.amount} ${perUnit.currency} minor units (requires ${condition.op} ${threshold.amount})`,
                  pricing.span
                )
              )
            }
          }
        }
        if (metric === "margin" && condition.threshold._tag === "PercentThreshold") {
          const threshold = Number(condition.threshold.value) / 100
          for (const pricing of field.fields) {
            if (pricing._tag !== "MarginField") continue
            const margin = Number(pricing.value) / 100
            if (!compare(margin, condition.op, threshold)) {
              diagnostics.push(
                report(
                  "VOID133",
                  `invariant \`${invariant.name}\` violated: product \`${product.id.name}\` prices \`${meterId}\` at a ${Number(pricing.value)}% margin (requires ${condition.op} ${condition.threshold.value}%)`,
                  pricing.span
                )
              )
            }
          }
        }
      }
    }
  }
}

export const check = (file: SourceFile): ReadonlyArray<Diagnostic> => {
  const diagnostics: Array<Diagnostic> = []

  const seen = new Map<string, string>()
  for (const decl of file.decls) {
    if (decl._tag === "InvariantDecl") continue
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

  const meters = file.decls.filter((d): d is MeterDecl => d._tag === "MeterDecl")
  const meterIds = new Set(meters.map((d) => d.id.name))
  const meterUnits = new Map(
    meters.flatMap((meter) => {
      const field = meter.fields.find(
        (f): f is Extract<MeterField, { _tag: "UnitField" }> => f._tag === "UnitField"
      )
      return field === undefined ? [] : [[meter.id.name, field.name.name] as const]
    })
  )

  const products = file.decls.filter((d): d is ProductDecl => d._tag === "ProductDecl")

  const invariantNames = new Set<string>()
  for (const decl of file.decls) {
    if (decl._tag !== "InvariantDecl") continue
    if (invariantNames.has(decl.name)) {
      diagnostics.push(
        D.error("VOID134", `duplicate invariant \`${decl.name}\``, decl.nameSpan)
      )
    }
    invariantNames.add(decl.name)
  }

  for (const decl of file.decls) {
    if (decl._tag === "MeterDecl") checkMeter(decl, diagnostics)
    else if (decl._tag === "ProductDecl") checkProduct(decl, meterIds, meterUnits, diagnostics)
    else checkInvariant(decl, meterIds, products, diagnostics)
  }

  return diagnostics
}

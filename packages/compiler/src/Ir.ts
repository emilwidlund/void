import type {
  Aggregate,
  ComparisonOp,
  FilterExpr,
  Interval,
  InvariantDecl,
  Literal,
  MeterDecl,
  Money,
  ProductDecl,
  SourceFile
} from "./Ast.js"
import { resolveUnit, unitFactor } from "./Units.js"

export interface IrMoney {
  readonly currency: string
  /**
   * Decimal string in the currency's minor units (e.g. cents for USD).
   * Kept as a string so sub-cent per-unit prices stay exact ("0.1" = a tenth of a cent).
   */
  readonly amount: string
}

export type IrFilter =
  | {
      readonly type: "comparison"
      readonly property: string
      readonly op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"
      readonly value: string | number | boolean
    }
  | { readonly type: "and" | "or"; readonly operands: ReadonlyArray<IrFilter> }

export type IrAggregation =
  | { readonly type: "count" }
  | {
      readonly type: "sum" | "max" | "min" | "avg" | "unique"
      readonly property: string
    }

export interface IrMeter {
  readonly id: string
  readonly filter: IrFilter | null
  readonly aggregation: IrAggregation
  /** canonical unit of the aggregated value ("second", "gigabyte", "token"), or null */
  readonly unit: string | null
}

export type IrPrice =
  | {
      readonly type: "recurring"
      readonly interval: "month" | "year" | "week" | "day"
      readonly amount: IrMoney
    }
  | {
      readonly type: "metered"
      readonly meter: string
      readonly per_unit: IrMoney
      readonly included_units: number
      /** canonical priced unit from `per <unit>`, or null when priced per meter unit */
      readonly per: string | null
      /**
       * Meter units per priced unit — usage is divided by this before unit
       * pricing (meter in ms priced per second -> 1000). 1 when no conversion.
       */
      readonly unit_factor: number
    }
  | {
      /**
       * Cost-derived pricing: the charge is reported cost / (1 - margin), so
       * the configured gross margin holds whatever the unit costs are.
       */
      readonly type: "metered_margin"
      readonly meter: string
      /** target gross margin as a fraction (60% -> 0.6) */
      readonly margin: number
    }

export type IrEntitlement =
  | { readonly type: "flag"; readonly id: string }
  | { readonly type: "limit"; readonly id: string; readonly limit: number }
  | {
      readonly type: "metered"
      readonly id: string
      readonly meter: string
      readonly limit: number
    }

export interface IrProduct {
  readonly id: string
  readonly name: string
  readonly prices: ReadonlyArray<IrPrice>
  readonly entitlements: ReadonlyArray<IrEntitlement>
}

/**
 * A declared invariant. Meter-scoped ones (`meter` set) were already proven
 * at compile time — they ride along for display and re-verification. Customer-
 * scoped ones (`meter` null) are runtime-monitored against live billing state.
 * `threshold` is minor units for money metrics (price, spend) and a fraction
 * for margin; `currency` is set only for money metrics.
 */
export interface IrInvariant {
  readonly name: string
  readonly metric: "price" | "margin" | "spend"
  readonly meter: string | null
  readonly op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"
  readonly threshold: number
  readonly currency: string | null
  /**
   * Remedy applied when the invariant is violated: `cap` clamps the bill at
   * the threshold, `block` flips enforcement on the entitlements endpoint,
   * `notify` emits an alert, `warn` softens the check. Null = observe only.
   */
  readonly behavior: "warn" | "cap" | "block" | "notify" | null
}

export interface BillingIr {
  readonly version: 1
  readonly meters: ReadonlyArray<IrMeter>
  readonly products: ReadonlyArray<IrProduct>
  readonly invariants: ReadonlyArray<IrInvariant>
}

/** Shifts the decimal point of a positive decimal string `places` digits to the right. */
export const shiftDecimal = (raw: string, places: number): string => {
  const [intPart = "0", fracPart = ""] = raw.split(".")
  const digits = intPart + fracPart
  const point = intPart.length + places

  let result: string
  if (point >= digits.length) {
    result = digits + "0".repeat(point - digits.length)
  } else if (point <= 0) {
    result = "0." + "0".repeat(-point) + digits
  } else {
    result = digits.slice(0, point) + "." + digits.slice(point)
  }

  result = result.replace(/^0+(?=\d)/, "")
  if (result.includes(".")) {
    result = result.replace(/0+$/, "").replace(/\.$/, "")
  }
  return result === "" ? "0" : result
}

/**
 * Normalizes a DSL money literal to minor units:
 * - `29.99 USD` (major units) -> { currency: "USD", amount: "2999" }
 * - `10 USD_CENTS` (already minor units) -> { currency: "USD", amount: "10" }
 */
export const toIrMoney = (money: Money): IrMoney =>
  money.currency.endsWith("_CENTS")
    ? { currency: money.currency.slice(0, -"_CENTS".length), amount: shiftDecimal(money.amount, 0) }
    : { currency: money.currency, amount: shiftDecimal(money.amount, 2) }

const OP_MAP: Record<ComparisonOp, "eq" | "ne" | "gt" | "gte" | "lt" | "lte"> = {
  "==": "eq",
  "!=": "ne",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte"
}

const literalValue = (literal: Literal): string | number | boolean => {
  switch (literal._tag) {
    case "StringLiteral":
      return literal.value
    case "NumberLiteral":
      return Number(literal.value)
    case "BooleanLiteral":
      return literal.value
  }
}

const emitFilter = (expr: FilterExpr): IrFilter => {
  if (expr._tag === "Comparison") {
    return {
      type: "comparison",
      property: expr.path.segments.join("."),
      op: OP_MAP[expr.op],
      value: literalValue(expr.value)
    }
  }
  // Flatten chains of the same operator: a and b and c -> one "and" node
  const operands: Array<IrFilter> = []
  for (const side of [expr.left, expr.right]) {
    const emitted = emitFilter(side)
    if (emitted.type === expr.op) operands.push(...emitted.operands)
    else operands.push(emitted)
  }
  return { type: expr.op, operands }
}

const emitAggregation = (aggregate: Aggregate): IrAggregation =>
  aggregate._tag === "Count"
    ? { type: "count" }
    : { type: aggregate.fn, property: aggregate.path.segments.join(".") }

const INTERVAL_MAP: Record<Interval, "month" | "year" | "week" | "day"> = {
  monthly: "month",
  yearly: "year",
  weekly: "week",
  daily: "day"
}

const emitMeter = (meter: MeterDecl): IrMeter => {
  let filter: IrFilter | null = null
  let aggregation: IrAggregation = { type: "count" }
  let unit: string | null = null
  for (const field of meter.fields) {
    if (field._tag === "FilterField") filter = emitFilter(field.expr)
    else if (field._tag === "AggregateField") aggregation = emitAggregation(field.aggregate)
    else unit = resolveUnit(field.name.name).canonical
  }
  return { id: meter.id.name, filter, aggregation, unit }
}

const emitProduct = (product: ProductDecl, meterUnits: ReadonlyMap<string, string>): IrProduct => {
  let name = product.id.name
  const prices: Array<IrPrice> = []
  const entitlements: Array<IrEntitlement> = []
  for (const field of product.fields) {
    if (field._tag === "NameField") {
      name = field.value
      continue
    }
    if (field._tag === "RecurringPriceField") {
      prices.push({
        type: "recurring",
        interval: INTERVAL_MAP[field.interval],
        amount: toIrMoney(field.money)
      })
      continue
    }
    if (field._tag === "EntitlementField") {
      let limit: number | undefined
      let meter: string | undefined
      for (const entitlementField of field.fields) {
        if (entitlementField._tag === "LimitField") limit = Number(entitlementField.value)
        else meter = entitlementField.meter.name
      }
      entitlements.push(
        meter !== undefined
          ? { type: "metered", id: field.id.name, meter, limit: limit ?? 0 }
          : limit !== undefined
            ? { type: "limit", id: field.id.name, limit }
            : { type: "flag", id: field.id.name }
      )
      continue
    }
    let perUnit: IrMoney = { currency: "USD", amount: "0" }
    let included = 0
    let margin: number | undefined
    let per: string | null = null
    let factor = 1
    for (const pricingField of field.fields) {
      if (pricingField._tag === "PerUnitField") {
        perUnit = toIrMoney(pricingField.money)
        if (pricingField.per !== null) {
          const priced = resolveUnit(pricingField.per.name)
          per = priced.canonical
          const meterUnit = meterUnits.get(field.meter.name)
          // Cross-dimension pairs are compile errors; here units are compatible.
          if (meterUnit !== undefined) factor = unitFactor(resolveUnit(meterUnit), priced)
        }
      } else if (pricingField._tag === "MarginField") {
        margin = Number(pricingField.value) / 100
      } else {
        included = Number(pricingField.value)
      }
    }
    prices.push(
      margin !== undefined
        ? { type: "metered_margin", meter: field.meter.name, margin }
        : {
            type: "metered",
            meter: field.meter.name,
            per_unit: perUnit,
            included_units: included,
            per,
            unit_factor: factor
          }
    )
  }
  return { id: product.id.name, name, prices, entitlements }
}

const emitInvariants = (file: SourceFile): ReadonlyArray<IrInvariant> =>
  file.decls
    .filter((d): d is InvariantDecl => d._tag === "InvariantDecl")
    .flatMap((decl) =>
      decl.conditions.map((condition): IrInvariant => {
        const threshold = condition.threshold
        const money =
          threshold._tag === "MoneyThreshold" ? toIrMoney(threshold.money) : null
        return {
          name: decl.name,
          metric: condition.metric.name as IrInvariant["metric"],
          meter: condition.arg.name === "customer" ? null : condition.arg.name,
          op: OP_MAP[condition.op],
          threshold:
            threshold._tag === "MoneyThreshold"
              ? Number(money?.amount ?? 0)
              : Number(threshold.value) / 100,
          currency: money?.currency ?? null,
          behavior: (condition.behavior?.name ?? null) as IrInvariant["behavior"]
        }
      })
    )

/** Emits the IR for a checked source file. Assumes `check` reported no errors. */
export const emit = (file: SourceFile): BillingIr => {
  const meters = file.decls
    .filter((d): d is MeterDecl => d._tag === "MeterDecl")
    .map(emitMeter)
  const meterUnits = new Map(
    meters.flatMap((meter) => (meter.unit === null ? [] : [[meter.id, meter.unit] as const]))
  )
  return {
    version: 1,
    meters,
    products: file.decls
      .filter((d): d is ProductDecl => d._tag === "ProductDecl")
      .map((product) => emitProduct(product, meterUnits)),
    invariants: emitInvariants(file)
  }
}

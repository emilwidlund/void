import type {
  Aggregate,
  ComparisonOp,
  FilterExpr,
  Interval,
  Literal,
  MeterDecl,
  Money,
  ProductDecl,
  SourceFile
} from "./Ast.js"

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
    }

export interface IrProduct {
  readonly id: string
  readonly name: string
  readonly prices: ReadonlyArray<IrPrice>
}

export interface BillingIr {
  readonly version: 1
  readonly meters: ReadonlyArray<IrMeter>
  readonly products: ReadonlyArray<IrProduct>
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
  for (const field of meter.fields) {
    if (field._tag === "FilterField") filter = emitFilter(field.expr)
    else aggregation = emitAggregation(field.aggregate)
  }
  return { id: meter.id.name, filter, aggregation }
}

const emitProduct = (product: ProductDecl): IrProduct => {
  let name = product.id.name
  const prices: Array<IrPrice> = []
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
    let perUnit: IrMoney = { currency: "USD", amount: "0" }
    let included = 0
    for (const pricingField of field.fields) {
      if (pricingField._tag === "PerUnitField") perUnit = toIrMoney(pricingField.money)
      else included = Number(pricingField.value)
    }
    prices.push({
      type: "metered",
      meter: field.meter.name,
      per_unit: perUnit,
      included_units: included
    })
  }
  return { id: product.id.name, name, prices }
}

/** Emits the IR for a checked source file. Assumes `check` reported no errors. */
export const emit = (file: SourceFile): BillingIr => ({
  version: 1,
  meters: file.decls.filter((d): d is MeterDecl => d._tag === "MeterDecl").map(emitMeter),
  products: file.decls
    .filter((d): d is ProductDecl => d._tag === "ProductDecl")
    .map(emitProduct)
})

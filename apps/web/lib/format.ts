import type { IrAggregation, IrFilter, IrMoney } from "@void/compiler"

/** Renders an IR filter back into DSL-ish text for display. */
export const formatFilter = (filter: IrFilter | null): string => {
  if (filter === null) return "(all events)"
  if (filter.type === "comparison") {
    const ops = { eq: "==", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const
    const value = typeof filter.value === "string" ? `"${filter.value}"` : String(filter.value)
    return `${filter.property} ${ops[filter.op]} ${value}`
  }
  return filter.operands.map((operand) => formatFilter(operand)).join(` ${filter.type} `)
}

export const formatAggregation = (aggregation: IrAggregation): string =>
  aggregation.type === "count" ? "count" : `${aggregation.type}(${aggregation.property})`

const SYMBOLS: Readonly<Record<string, string>> = { USD: "$", EUR: "€", GBP: "£" }

/** Formats a minor-units decimal amount (e.g. "2900" cents) as major units. */
export const formatMoney = (money: IrMoney): string => {
  const major = Number(money.amount) / 100
  const symbol = SYMBOLS[money.currency]
  const digits = major > 0 && major < 0.01 ? 6 : 2
  const rendered = major.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits
  })
  return symbol !== undefined ? `${symbol}${rendered}` : `${rendered} ${money.currency}`
}

export const formatUnits = (value: number): string =>
  Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : value.toLocaleString("en-US", { maximumFractionDigits: 2 })

export const shortChecksum = (checksum: string): string =>
  checksum.replace("sha256:", "").slice(0, 12)

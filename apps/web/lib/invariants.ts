import type { IrInvariant } from "@void/compiler"
import { formatMinor } from "./format"
import type { SpendOverview } from "./spend"

export interface InvariantViolation {
  readonly name: string
  readonly text: string
}

const OPS: Readonly<Record<IrInvariant["op"], string>> = {
  eq: "=",
  ne: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤"
}

const REMEDIES: Readonly<Record<string, string>> = {
  observe: "",
  warn: " · warning only",
  cap: " · remedied: bill capped at the threshold",
  block: " · enforcement: blocked",
  notify: " · notification emitted"
}

const compare = (left: number, op: IrInvariant["op"], right: number): boolean => {
  switch (op) {
    case "eq":
      return left === right
    case "ne":
      return left !== right
    case "gt":
      return left > right
    case "gte":
      return left >= right
    case "lt":
      return left < right
    case "lte":
      return left <= right
  }
}

/**
 * Evaluates the runtime (customer-scoped) invariants against live billing
 * state. Meter-scoped invariants were already proven at compile time and are
 * skipped here.
 */
export const evaluateInvariants = (
  invariants: ReadonlyArray<IrInvariant>,
  spend: SpendOverview
): ReadonlyArray<InvariantViolation> => {
  const violations: Array<InvariantViolation> = []
  for (const invariant of invariants) {
    if (invariant.meter !== null) continue
    const remedy = REMEDIES[invariant.behavior ?? "observe"]
    for (const customer of spend.customers) {
      if (invariant.metric === "spend") {
        // The cap clamps what gets billed; the condition tests what would
        // have been billed — a capped bill is a remedied violation, not none.
        const total = customer.uncappedSpendMinor
        if (!compare(total, invariant.op, invariant.threshold)) {
          const currency = invariant.currency ?? customer.currency
          violations.push({
            name: invariant.name,
            text: `${customer.customer} has spent ${formatMinor(total, currency)} this period — requires ${OPS[invariant.op]} ${formatMinor(invariant.threshold, currency)}${remedy}`
          })
        }
      } else if (invariant.metric === "margin") {
        if (customer.marginPct === null || customer.projectedCostMinor === 0) continue
        if (!compare(customer.marginPct, invariant.op, invariant.threshold)) {
          violations.push({
            name: invariant.name,
            text: `${customer.customer}'s gross margin is ${Math.round(customer.marginPct * 100)}% — requires ${OPS[invariant.op]} ${Math.round(invariant.threshold * 100)}%${remedy}`
          })
        }
      }
    }
  }
  return violations
}

/** Renders an invariant back into DSL-ish text for the config panel. */
export const formatInvariant = (invariant: IrInvariant): string => {
  const subject = `${invariant.metric}(${invariant.meter ?? "customer"})`
  const threshold =
    invariant.metric === "margin"
      ? `${Math.round(invariant.threshold * 100)}%`
      : formatMinor(invariant.threshold, invariant.currency ?? "USD")
  const behavior = invariant.behavior !== null ? ` else ${invariant.behavior}` : ""
  return `${subject} ${OPS[invariant.op]} ${threshold}${behavior}`
}

import type {
  BillingIr,
  IrEntitlement,
  IrFilter,
  IrInvariant,
  IrMeter,
  IrMoney,
  IrOutcome,
  IrOverride,
  IrPrice,
  IrProduct
} from "@void/compiler"
import { resolveUnit, shiftDecimal, unitFactor } from "@void/compiler"
import { createHash } from "node:crypto"
import type {
  ConfigShape,
  EntitlementConfig,
  Filter,
  InvariantConfig,
  MeterConfig,
  Money,
  OverrideConfig,
  ProductConfig,
  Span,
  UsagePricing
} from "./Config.js"
import { isComparison, isOutcomeConfig } from "./Config.js"

/**
 * Compiles a `defineConfig` config into the same canonical IR the `.void`
 * compiler emits — identical key order, so both frontends produce identical
 * JSON and therefore identical deploy checksums.
 */

const fail = (message: string): never => {
  throw new Error(`defineConfig: ${message}`)
}

export const checksumIr = (ir: BillingIr): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(ir)).digest("hex")}`

const toIrMoney = (value: Money): IrMoney => ({
  currency: value.currency,
  amount: shiftDecimal(String(value.amount), value.minor ? 0 : 2)
})

const toIrFilter = (filter: Filter | undefined, context: string): IrFilter | null => {
  if (filter === undefined) return null
  const operands: Array<IrFilter> = []
  if (filter.event !== undefined) {
    operands.push({
      type: "comparison",
      property: "event.name",
      op: "eq",
      value: filter.event
    })
  }
  for (const [key, matcher] of Object.entries(filter.where ?? {})) {
    operands.push(
      isComparison(matcher)
        ? {
            type: "comparison",
            property: `event.${key}`,
            op: matcher.op,
            value: matcher.value
          }
        : { type: "comparison", property: `event.${key}`, op: "eq", value: matcher }
    )
  }
  if (operands.length === 0) fail(`${context}: empty filter`)
  return operands.length === 1 ? operands[0]! : { type: "and", operands }
}

const toWindowSeconds = (span: Span | undefined, context: string): number | null => {
  if (span === undefined) return null
  const match = /^(\d+(?:\.\d+)?)\s+([a-z]+)$/.exec(span)
  const unit = match !== null ? resolveUnit(match[2]!) : null
  if (match === null || unit === null || unit.dimension !== "time") {
    return fail(`${context}: invalid time span \`${span}\` (expected e.g. "7 days")`)
  }
  return Number(match[1]) * unit.factor
}

const percentToFraction = (value: string, context: string): number => {
  const match = /^(\d+(?:\.\d+)?)%$/.exec(value)
  if (match === null) return fail(`${context}: invalid percentage \`${value}\``)
  return Number(match[1]) / 100
}

const toIrMeter = (id: string, meter: MeterConfig): IrMeter => {
  if (isOutcomeConfig(meter)) return fail(`meter \`${id}\`: outcome config in meter path`)
  const unit = meter.unit !== undefined ? resolveUnit(meter.unit) : null
  if (meter.unit !== undefined && unit === null) {
    fail(`meter \`${id}\`: unknown unit \`${meter.unit}\``)
  }
  return {
    id,
    filter: toIrFilter(meter.filter, `meter \`${id}\``) ?? null,
    aggregation:
      meter.aggregate === "count"
        ? { type: "count" }
        : (() => {
            const [fn, property] = Object.entries(meter.aggregate)[0] as [
              "sum" | "max" | "min" | "avg" | "unique",
              string
            ]
            return { type: fn, property: `event.${property}` }
          })(),
    unit: unit?.canonical ?? null,
    reverse:
      meter.reverseOn !== undefined
        ? {
            filter:
              toIrFilter(meter.reverseOn.on, `meter \`${id}\` reverseOn`) ??
              fail(`meter \`${id}\`: reverseOn needs a filter`),
            window_s: toWindowSeconds(meter.reverseOn.within, `meter \`${id}\``)
          }
        : null
  }
}

const toIrOutcome = (id: string, outcome: MeterConfig): IrOutcome => {
  if (!isOutcomeConfig(outcome)) return fail(`outcome \`${id}\`: not a chain config`)
  if (outcome.steps.length === 0) fail(`outcome \`${id}\`: needs at least one step`)
  return {
    id,
    correlate: `event.${outcome.correlate}`,
    steps: outcome.steps.map(
      (step, index) =>
        toIrFilter(step, `outcome \`${id}\` step ${index + 1}`) ??
        fail(`outcome \`${id}\`: step ${index + 1} is empty`)
    ),
    fail:
      outcome.failOn !== undefined
        ? {
            filter:
              toIrFilter(outcome.failOn.on, `outcome \`${id}\` failOn`) ??
              fail(`outcome \`${id}\`: failOn needs a filter`),
            window_s: toWindowSeconds(outcome.failOn.within, `outcome \`${id}\``)
          }
        : null
  }
}

const toIrPrices = (
  owner: string,
  price: { every: string; amount: Money } | undefined,
  usage: Partial<Readonly<Record<string, UsagePricing>>> | undefined,
  meters: Readonly<Record<string, MeterConfig>>
): Array<IrPrice> => {
  const prices: Array<IrPrice> = []
  if (price !== undefined) {
    prices.push({
      type: "recurring",
      interval: price.every as "month" | "year" | "week" | "day",
      amount: toIrMoney(price.amount)
    })
  }
  for (const [meterId, pricing] of Object.entries(usage ?? {})) {
    if (pricing === undefined) continue
    const declared = meters[meterId]
    if (declared === undefined) {
      fail(`${owner}: prices unknown meter \`${meterId}\``)
    }
    if ("margin" in pricing) {
      if (isOutcomeConfig(declared!)) {
        fail(`${owner}: outcomes are priced perUnit — \`${meterId}\` cannot use margin`)
      }
      const margin = percentToFraction(pricing.margin, `${owner}.${meterId}`)
      if (!(margin > 0 && margin < 1)) {
        fail(`${owner}.${meterId}: margin must be between 0% and 100% (exclusive)`)
      }
      prices.push({ type: "metered_margin", meter: meterId, margin })
      continue
    }
    let per: string | null = null
    let factor = 1
    if (pricing.per !== undefined) {
      const priced = resolveUnit(pricing.per)
      if (priced === null) fail(`${owner}.${meterId}: unknown unit \`${pricing.per}\``)
      per = priced!.canonical
      const meterUnitName = isOutcomeConfig(declared!)
        ? "scalar"
        : (declared as { unit?: string }).unit
      const meterUnit = meterUnitName !== undefined ? resolveUnit(meterUnitName) : null
      if (meterUnit !== null && priced !== null) {
        if (meterUnit.dimension !== priced.dimension) {
          fail(
            `${owner}.${meterId}: meter aggregates \`${meterUnit.canonical}\` but the price is per \`${priced.canonical}\` — not convertible`
          )
        }
        factor = unitFactor(meterUnit, priced)
      }
    }
    prices.push({
      type: "metered",
      meter: meterId,
      per_unit: toIrMoney(pricing.perUnit),
      included_units: pricing.included ?? 0,
      per,
      unit_factor: factor
    })
  }
  return prices
}

const toIrEntitlements = (
  entitlements: Readonly<Record<string, EntitlementConfig>> | undefined
): Array<IrEntitlement> =>
  Object.entries(entitlements ?? {}).map(([id, config]): IrEntitlement => {
    if (config === true) return { type: "flag", id }
    if ("meter" in config) {
      return { type: "metered", id, meter: config.meter, limit: config.limit }
    }
    return { type: "limit", id, limit: config.limit }
  })

const toIrProduct = (
  id: string,
  product: ProductConfig,
  meters: Readonly<Record<string, MeterConfig>>
): IrProduct => ({
  id,
  name: product.name,
  prices: toIrPrices(`product \`${id}\``, product.price, product.usage, meters),
  entitlements: toIrEntitlements(product.entitlements)
})

const toIrOverride = (
  customer: string,
  override: OverrideConfig,
  meters: Readonly<Record<string, MeterConfig>>
): IrOverride => ({
  customer,
  until: override.until ?? null,
  prices: toIrPrices(
    `override \`${customer}\``,
    override.price,
    override.usage,
    meters
  ),
  entitlements: toIrEntitlements(override.entitlements)
})

const OPS = ["gte", "lte", "gt", "lt"] as const

const toIrInvariant = (invariant: InvariantConfig): IrInvariant => {
  const assert = invariant.assert as Record<string, unknown>
  const op = OPS.find((candidate) => candidate in assert)
  if (op === undefined) {
    return fail(`invariant \`${invariant.name}\`: needs one of ${OPS.join("/")}`)
  }
  const threshold = assert[op]
  const [metric, subject] =
    "price" in assert
      ? (["price", assert["price"]] as const)
      : "spend" in assert
        ? (["spend", assert["spend"]] as const)
        : (["margin", assert["margin"]] as const)
  const money =
    typeof threshold === "object" && threshold !== null
      ? toIrMoney(threshold as Money)
      : null
  return {
    name: invariant.name,
    metric,
    meter: subject === "customer" ? null : (subject as string),
    op,
    threshold:
      money !== null
        ? Number(money.amount)
        : percentToFraction(String(threshold), `invariant \`${invariant.name}\``),
    currency: money?.currency ?? null,
    behavior: invariant.else ?? null
  }
}

/** Mirrors the checker's VOID133: proves meter-scoped invariants statically. */
const verifyInvariants = (ir: BillingIr): { warnings: Array<string> } => {
  const warnings: Array<string> = []
  const errors: Array<string> = []
  const compare = (left: number, op: IrInvariant["op"], right: number): boolean =>
    op === "gte" ? left >= right : op === "lte" ? left <= right : op === "gt" ? left > right : op === "lt" ? left < right : op === "eq" ? left === right : left !== right

  const sources = [
    ...ir.products.map((p) => ({ label: `product \`${p.id}\``, prices: p.prices })),
    ...ir.overrides.map((o) => ({ label: `override for \`${o.customer}\``, prices: o.prices }))
  ]
  for (const invariant of ir.invariants) {
    if (invariant.meter === null) continue // runtime-monitored
    for (const source of sources) {
      for (const price of source.prices) {
        if (price.type === "recurring" || price.meter !== invariant.meter) continue
        let violation: string | null = null
        if (invariant.metric === "price" && price.type === "metered") {
          if (price.per_unit.currency !== invariant.currency) {
            errors.push(
              `invariant \`${invariant.name}\`: compares ${invariant.currency} but ${source.label} prices \`${invariant.meter}\` in ${price.per_unit.currency}`
            )
            continue
          }
          if (!compare(Number(price.per_unit.amount), invariant.op, invariant.threshold)) {
            violation = `invariant \`${invariant.name}\` violated: ${source.label} prices \`${invariant.meter}\` at ${price.per_unit.amount} ${price.per_unit.currency} minor units (requires ${invariant.op} ${invariant.threshold})`
          }
        }
        if (invariant.metric === "margin" && price.type === "metered_margin") {
          if (!compare(price.margin, invariant.op, invariant.threshold)) {
            violation = `invariant \`${invariant.name}\` violated: ${source.label} prices \`${invariant.meter}\` at a ${Math.round(price.margin * 100)}% margin (requires ${invariant.op} ${Math.round(invariant.threshold * 100)}%)`
          }
        }
        if (violation !== null) {
          if (invariant.behavior === "warn") warnings.push(violation)
          else errors.push(violation)
        }
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`defineConfig: config violates its invariants\n${errors.join("\n")}`)
  }
  return { warnings }
}

const eventNamesInFilter = (filter: IrFilter | null, into: Set<string>): void => {
  if (filter === null) return
  if (filter.type === "comparison") {
    if (filter.property === "event.name" && filter.op === "eq") {
      into.add(String(filter.value))
    }
    return
  }
  for (const operand of filter.operands) eventNamesInFilter(operand, into)
}

/** Every event name the IR mentions — the runtime twin of `EventNameOf`. */
export const collectEventNames = (ir: BillingIr): ReadonlyArray<string> => {
  const names = new Set<string>()
  for (const meter of ir.meters) {
    eventNamesInFilter(meter.filter, names)
    if (meter.reverse !== null) eventNamesInFilter(meter.reverse.filter, names)
  }
  for (const outcome of ir.outcomes) {
    for (const step of outcome.steps) eventNamesInFilter(step, names)
    if (outcome.fail !== null) eventNamesInFilter(outcome.fail.filter, names)
  }
  return [...names]
}

export const compileConfig = <C extends ConfigShape<C>>(
  config: C
): { ir: BillingIr; checksum: string; warnings: ReadonlyArray<string> } => {
  const meterEntries = Object.entries(config.meters as Record<string, MeterConfig>)
  const ir: BillingIr = {
    version: 1,
    meters: meterEntries
      .filter(([, meter]) => !isOutcomeConfig(meter))
      .map(([id, meter]) => toIrMeter(id, meter)),
    outcomes: meterEntries
      .filter(([, meter]) => isOutcomeConfig(meter))
      .map(([id, meter]) => toIrOutcome(id, meter)),
    products: Object.entries(config.products as Record<string, ProductConfig>).map(
      ([id, product]) => toIrProduct(id, product, config.meters)
    ),
    invariants: (config.invariants ?? []).map((invariant) =>
      toIrInvariant(invariant as InvariantConfig)
    ),
    overrides: Object.entries(
      (config.overrides ?? {}) as Record<string, OverrideConfig>
    ).map(([customer, override]) => toIrOverride(customer, override, config.meters))
  }
  const { warnings } = verifyInvariants(ir)
  return { ir, checksum: checksumIr(ir), warnings }
}

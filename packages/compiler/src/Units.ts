/**
 * Unit registry for dimensional analysis. Units exist for dimensioned
 * quantities — time and data — with a conversion factor to the dimension's
 * base unit, so a meter recording milliseconds can be priced per second and
 * the compiler emits the conversion. Everything countable (requests, tokens,
 * seats, ...) is the dimensionless `scalar` unit; unknown unit names are
 * compile errors rather than ad-hoc dimensions.
 */

export interface ResolvedUnit {
  /** normalized singular name ("seconds" -> "second", "ms" -> "millisecond") */
  readonly canonical: string
  /** units in the same dimension are convertible; distinct dimensions are not */
  readonly dimension: string
  /** size of this unit expressed in the dimension's base unit */
  readonly factor: number
}

const unit = (canonical: string, dimension: string, factor: number): ResolvedUnit => ({
  canonical,
  dimension,
  factor
})

const KNOWN: Readonly<Record<string, ResolvedUnit>> = {
  // dimensionless counts
  scalar: unit("scalar", "scalar", 1),
  // time (base: second)
  ms: unit("millisecond", "time", 0.001),
  millisecond: unit("millisecond", "time", 0.001),
  s: unit("second", "time", 1),
  sec: unit("second", "time", 1),
  second: unit("second", "time", 1),
  min: unit("minute", "time", 60),
  minute: unit("minute", "time", 60),
  h: unit("hour", "time", 3600),
  hr: unit("hour", "time", 3600),
  hour: unit("hour", "time", 3600),
  day: unit("day", "time", 86_400),
  // data (base: byte, decimal multiples)
  b: unit("byte", "data", 1),
  byte: unit("byte", "data", 1),
  kb: unit("kilobyte", "data", 1e3),
  kilobyte: unit("kilobyte", "data", 1e3),
  mb: unit("megabyte", "data", 1e6),
  megabyte: unit("megabyte", "data", 1e6),
  gb: unit("gigabyte", "data", 1e9),
  gigabyte: unit("gigabyte", "data", 1e9),
  tb: unit("terabyte", "data", 1e12),
  terabyte: unit("terabyte", "data", 1e12)
}

/** Display list of known units, for tooling (completion, docs, diagnostics). */
export const KNOWN_UNIT_NAMES: ReadonlyArray<string> = [
  "scalar",
  "ms",
  "seconds",
  "minutes",
  "hours",
  "days",
  "bytes",
  "kb",
  "mb",
  "gb",
  "tb"
]

/** Resolves a unit name (aliases and plurals included), or null if unknown. */
export const resolveUnit = (raw: string): ResolvedUnit | null => {
  const lower = raw.toLowerCase()
  const direct = KNOWN[lower]
  if (direct !== undefined) return direct
  // Plural of a known unit: "seconds" -> "second". Two-letter names ("ms")
  // are never stripped.
  const singular =
    lower.endsWith("s") && lower.length > 2 ? lower.slice(0, -1) : lower
  return KNOWN[singular] ?? null
}

/**
 * How many meter units make up one priced unit — the divisor applied to
 * usage before unit pricing. Meter in ms priced per second -> 1000.
 */
export const unitFactor = (meterUnit: ResolvedUnit, pricedUnit: ResolvedUnit): number =>
  pricedUnit.factor / meterUnit.factor

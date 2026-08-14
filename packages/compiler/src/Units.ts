/**
 * Unit registry for dimensional analysis. Known units belong to a dimension
 * (time, data) with a conversion factor to that dimension's base unit, so a
 * meter recording milliseconds can be priced per second and the compiler
 * emits the conversion. Unknown units (tokens, requests, seats, ...) are
 * opaque: they form their own dimension and only match themselves, so
 * user-defined units still get mismatch checking for free.
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

/** Display list of known units, for tooling (completion, docs). */
export const KNOWN_UNIT_NAMES: ReadonlyArray<string> = [
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

export const resolveUnit = (raw: string): ResolvedUnit => {
  const lower = raw.toLowerCase()
  const direct = KNOWN[lower]
  if (direct !== undefined) return direct
  // Plural of a known or custom unit: "seconds" -> "second", "tokens" -> "token".
  // Two-letter names ("ms") are never stripped.
  const singular =
    lower.endsWith("s") && lower.length > 2 ? lower.slice(0, -1) : lower
  const known = KNOWN[singular]
  if (known !== undefined) return known
  return unit(singular, `custom:${singular}`, 1)
}

/**
 * How many meter units make up one priced unit — the divisor applied to
 * usage before unit pricing. Meter in ms priced per second -> 1000.
 */
export const unitFactor = (meterUnit: ResolvedUnit, pricedUnit: ResolvedUnit): number =>
  pricedUnit.factor / meterUnit.factor

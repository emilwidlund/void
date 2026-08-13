import { Schema } from "effect"
import type { BillingIr, IrFilter } from "./Ir.js"

/**
 * effect/Schema definitions mirroring the IR types in `Ir.ts`.
 *
 * IMPORTANT: struct field order matches the construction order in `emit` —
 * decoding a payload and re-serializing it with `JSON.stringify` must produce
 * byte-identical JSON so IR checksums survive a decode/encode round-trip.
 */

export const IrMoneySchema = Schema.Struct({
  currency: Schema.String,
  amount: Schema.String
})

const ComparisonSchema = Schema.Struct({
  type: Schema.Literal("comparison"),
  property: Schema.String,
  op: Schema.Literal("eq", "ne", "gt", "gte", "lt", "lte"),
  value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean)
})

export const IrFilterSchema: Schema.Schema<IrFilter> = Schema.Union(
  ComparisonSchema,
  Schema.Struct({
    type: Schema.Literal("and", "or"),
    operands: Schema.Array(Schema.suspend((): Schema.Schema<IrFilter> => IrFilterSchema))
  })
)

export const IrAggregationSchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal("count") }),
  Schema.Struct({
    type: Schema.Literal("sum", "max", "min", "avg", "unique"),
    property: Schema.String
  })
)

export const IrMeterSchema = Schema.Struct({
  id: Schema.String,
  filter: Schema.NullOr(IrFilterSchema),
  aggregation: IrAggregationSchema
})

export const IrPriceSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("recurring"),
    interval: Schema.Literal("month", "year", "week", "day"),
    amount: IrMoneySchema
  }),
  Schema.Struct({
    type: Schema.Literal("metered"),
    meter: Schema.String,
    per_unit: IrMoneySchema,
    included_units: Schema.Number
  })
)

export const IrProductSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  prices: Schema.Array(IrPriceSchema)
})

export const BillingIrSchema: Schema.Schema<BillingIr> = Schema.Struct({
  version: Schema.Literal(1),
  meters: Schema.Array(IrMeterSchema),
  products: Schema.Array(IrProductSchema)
})

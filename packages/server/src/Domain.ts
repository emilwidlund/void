import { BillingIrSchema } from "@void/compiler"
import { Schema } from "effect"

export const PropertyValueSchema = Schema.Union(Schema.String, Schema.Number, Schema.Boolean)
export type PropertyValue = typeof PropertyValueSchema.Type

export const IngestEventSchema = Schema.Struct({
  name: Schema.String,
  external_customer_id: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  /**
   * Optional cost incurred serving this event. `amount` is in major currency
   * units (`{ "amount": 0.0042, "currency": "USD" }` = $0.0042 — how apps
   * naturally compute AI/API costs). Costs accrue whether or not any meter
   * matches the event.
   */
  _cost: Schema.optional(
    Schema.Struct({
      amount: Schema.Number.pipe(Schema.nonNegative()),
      currency: Schema.String.pipe(Schema.pattern(/^[A-Z]{3}$/))
    })
  ),
  properties: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: PropertyValueSchema }),
    { default: () => ({}) }
  )
})
export type IngestEvent = typeof IngestEventSchema.Type

export const IngestRequestSchema = Schema.Struct({
  events: Schema.NonEmptyArray(IngestEventSchema)
})

export const DeployPayloadSchema = Schema.Struct({
  checksum: Schema.String,
  ir: BillingIrSchema,
  meta: Schema.optional(
    Schema.Struct({
      source: Schema.optional(Schema.String),
      compiler: Schema.optional(Schema.String)
    })
  )
})
export type DeployPayload = typeof DeployPayloadSchema.Type

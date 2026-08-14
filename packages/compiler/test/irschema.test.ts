import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { BillingIrSchema, compile } from "../src/index.js"

const source = `
  meter api_calls {
    filter event.name == "api.request" and event.billable == true
    aggregate count
  }
  meter compute_seconds {
    aggregate sum(event.duration_s)
    unit seconds
  }
  invariant "bill shock" { spend(customer) <= 500 USD }
  invariant "healthy compute" { margin(customer) >= 20% }
  product unit_product {
    name "Unit Product"
    meter compute_seconds { per_unit 3.6 USD per hour }
  }
  product margin_product {
    name "Margin Product"
    meter compute_seconds { margin 60% }
  }
  product pro {
    name "Pro Plan"
    price recurring monthly 29 USD
    entitlement sso
    entitlement seats { limit 5 }
    entitlement api_quota { meter api_calls limit 100_000 }
    meter api_calls {
      per_unit 10 USD_CENTS
      included 10_000
    }
  }
`

describe("BillingIrSchema", () => {
  it("decodes emitted IR and round-trips to identical JSON", () => {
    const { ir } = Effect.runSync(compile(source))
    const wire = JSON.stringify(ir)
    const decoded = Schema.decodeUnknownSync(BillingIrSchema)(JSON.parse(wire))
    expect(decoded).toEqual(ir)
    // Byte-identical re-serialization is what keeps deploy checksums stable
    expect(JSON.stringify(decoded)).toBe(wire)
  })

  it("rejects malformed IR", () => {
    expect(() =>
      Schema.decodeUnknownSync(BillingIrSchema)({ version: 2, meters: [], products: [] })
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(BillingIrSchema)({
        version: 1,
        meters: [{ id: "m", filter: null, aggregation: { type: "median" } }],
        products: []
      })
    ).toThrow()
  })
})

import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { compile, formatSource, parse, tokenize } from "../src/index.js"

const format = (source: string): string => {
  const lexed = tokenize(source)
  const parsed = parse(lexed.tokens)
  expect(parsed.diagnostics).toEqual([])
  return formatSource(parsed.file, lexed.comments)
}

describe("formatSource", () => {
  it("canonicalizes spacing, indentation and number grouping", () => {
    const messy = `meter    api_calls   {
        filter   event.name    ==   "api.request"
      aggregate count
          unit requests }
product pro { name "Pro Plan"
  price recurring monthly 29 USD
  meter api_calls { per_unit 10 USD_CENTS
  included 10000 } }`
    expect(format(messy)).toBe(`meter api_calls {
  filter event.name == "api.request"
  aggregate count
  unit requests
}

product pro {
  name "Pro Plan"
  price recurring monthly 29 USD
  meter api_calls {
    per_unit 10 USD_CENTS
    included 10_000
  }
}
`)
  })

  it("inlines single-field blocks and keeps bare entitlements bare", () => {
    const source = `product pro {
  name "Pro"
  entitlement sso
  entitlement seats {
    limit 5
  }
  meter compute {
    margin 60%
  }
}
meter compute { aggregate sum(event.duration_s) }
invariant "bill shock" {
  spend(customer) <= 500 USD else cap
}`
    expect(format(source)).toBe(`product pro {
  name "Pro"
  entitlement sso
  entitlement seats { limit 5 }
  meter compute { margin 60% }
}

meter compute { aggregate sum(event.duration_s) }

invariant "bill shock" { spend(customer) <= 500 USD else cap }
`)
  })

  it("preserves leading, trailing and standalone comments", () => {
    const source = `# Billing for the Pro plan.

# The API meter.
meter api_calls {
  # every request counts
  filter event.name == "api.request"
  aggregate count  # simple tally
}
`
    expect(format(source)).toBe(source)
  })

  it("preserves blank-line grouping between fields", () => {
    const source = `product pro {
  name "Pro"
  price recurring monthly 29 USD

  entitlement sso

  meter api_calls {
    per_unit 10 USD_CENTS
    included 10_000
  }
}
`
    expect(format(source)).toBe(source)
  })

  it("parenthesizes or-expressions under and", () => {
    const source = `meter m {
  filter (event.a == 1 or event.b == 2) and event.c == 3
  aggregate count
}
`
    expect(format(source)).toBe(source)
  })

  it("is idempotent and semantics-preserving on a full config", () => {
    const source = `# header comment
invariant "compute stays profitable" {
  margin(compute_seconds) >= 40%
}

meter api_calls {
  filter event.name == "api.request" or event.name == "api.retry"
  aggregate count
  unit scalar
}

meter compute_seconds {
  filter event.name == "compute.done" and event.status == "success"
  aggregate sum(event.duration_s)
  unit seconds
}

product pro {
  name "Pro Plan"
  price recurring monthly 29 USD
  entitlement sso
  entitlement api_quota {
    meter api_calls
    limit 100_000
  }
  meter api_calls {
    per_unit 10 USD_CENTS per scalar
    included 10_000
  }
  meter compute_seconds { margin 60% }
}

invariant "bill shock" { spend(customer) <= 500 USD else cap }
`
    const once = format(source)
    expect(format(once)).toBe(once)
    const before = Effect.runSync(compile(source)).ir
    const after = Effect.runSync(compile(once)).ir
    expect(after).toEqual(before)
  })
})

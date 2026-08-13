# void

Billing as code — a DSL for usage-based billing. Define meters that aggregate
events into billable units, and products with recurring and metered prices, in
`.void` files that compile to a canonical JSON IR.

```
meter api_calls {
  filter event.name == "api.request"
  aggregate count
}

meter compute_seconds {
  filter event.name == "compute.done" and event.status == "success"
  aggregate sum(event.duration_s)
}

product pro {
  name "Pro Plan"
  price recurring monthly 29 USD
  price metered api_calls {
    per_unit 10 USD_CENTS
    included 10_000
  }
}
```

## Usage

```sh
pnpm install
pnpm build

# Validate a config (exit code 1 on errors, rustc-style diagnostics)
node packages/cli/dist/bin.js check examples/pro.void

# Compile to JSON IR on stdout
node packages/cli/dist/bin.js build examples/pro.void
```

## Language

- **`meter <id> { ... }`** — aggregates ingested events into billable units.
  - `filter <expr>` — which events count. Comparisons (`==`, `!=`, `>`, `>=`,
    `<`, `<=`) over `event.*` properties, combined with `and` / `or` and
    parentheses (`and` binds tighter).
  - `aggregate <fn>` — `count`, or `sum|max|min|avg|unique(event.<property>)`.
- **`product <id> { ... }`** — a sellable product.
  - `name "..."` — display name (required).
  - `price recurring <monthly|yearly|weekly|daily> <amount> <currency>`
  - `price metered <meter> { per_unit <amount> <currency>  included <n> }`
- **Money** — `29.99 USD` is major units; a `_CENTS` suffix (`10 USD_CENTS`)
  means minor units. The IR normalizes everything to decimal strings in minor
  units, so sub-cent unit prices stay exact (`0.001 USD` → `"0.1"` cents).
- Comments start with `#`. Numbers may use `_` separators (`10_000`).

## Workspace

| Package | Purpose |
| --- | --- |
| `@void/compiler` | Lexer → parser → checker → IR emitter, span-based diagnostics. Built on [Effect](https://effect.website). |
| `@void/cli` | `void` CLI (`init`, `check`, `build`) built on `@effect/cli`. |

Common commands: `pnpm build`, `pnpm test`, `pnpm typecheck` (all via Turborepo),
and `pnpm --filter @void/cli dev` to run the CLI from source.

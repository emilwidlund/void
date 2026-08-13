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
  meter api_calls {
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

# Deploy the checksummed IR to a void server (built for CI/CD)
node packages/cli/dist/bin.js deploy examples/pro.void --endpoint https://... --token ...
node packages/cli/dist/bin.js deploy examples/pro.void --dry-run   # print payload only
```

`deploy` POSTs `{ checksum, ir, meta }` where `checksum` is sha256 over the
canonical compact IR JSON — comment or formatting changes don't produce a new
version, so a server can no-op on an already-deployed checksum. `--endpoint`
and `--token` fall back to the `VOID_ENDPOINT` / `VOID_TOKEN` environment
variables, and a compile error or non-2xx response exits 1, so it drops
straight into a CI/CD pipeline.

## Language

- **`meter <id> { ... }`** — aggregates ingested events into billable units.
  - `filter <expr>` — which events count. Comparisons (`==`, `!=`, `>`, `>=`,
    `<`, `<=`) over `event.*` properties, combined with `and` / `or` and
    parentheses (`and` binds tighter).
  - `aggregate <fn>` — `count`, or `sum|max|min|avg|unique(event.<property>)`.
- **`product <id> { ... }`** — a sellable product.
  - `name "..."` — display name (required).
  - `price recurring <monthly|yearly|weekly|daily> <amount> <currency>`
  - `meter <id> { per_unit <amount> <currency>  included <n> }` — binds a
    top-level meter to the product with its usage pricing. The same meter can
    be priced differently by different products.
- **Money** — `29.99 USD` is major units; a `_CENTS` suffix (`10 USD_CENTS`)
  means minor units. The IR normalizes everything to decimal strings in minor
  units, so sub-cent unit prices stay exact (`0.001 USD` → `"0.1"` cents).
- Comments start with `#`. Numbers may use `_` separators (`10_000`).

## Workspace

| Package | Purpose |
| --- | --- |
| `@void/compiler` | Lexer → parser → checker → IR emitter, span-based diagnostics, IR schema. Built on [Effect](https://effect.website). |
| `@void/cli` | `void` CLI (`init`, `check`, `build`, `deploy`) built on `@effect/cli`. |
| `@void/server` | Void server: accepts deploys, ingests events, runs meter aggregation. |
| `@void/web` | Next.js dashboard (`apps/web`): live usage, run-rate forecasts, deployed config. |

## Server

`pnpm dev` starts the server and dashboard together (via Turborepo). To run
just the server: `pnpm --filter @void/server dev` (`PORT`, default 4000).
Endpoints:

- `POST /v1/deploy` — accepts `{ checksum, ir, meta }` from `void deploy`. The
  IR is parsed with the compiler's schema and the checksum re-verified; an
  already-active checksum is a no-op (`unchanged`), otherwise a new config
  version is stored.
- `POST /v1/events` — batch event ingestion: `{ "events": [{ "name": "api.request",
  "external_customer_id": "acme", "properties": { ... } }] }`. Every event is
  evaluated against each meter's filter and folded into its aggregation
  (count/sum/max/min/avg/unique), keyed per customer.
- `GET /v1/usage` — aggregated usage per meter and customer.
- `GET /v1/config` — the active config version.
- `GET /v1/stream` — server-sent events: a full `{ usage, config }` snapshot
  on connect, then one per ingested batch or deploy (the dashboard's live feed).

State is in-memory for now — a real deployment would back the config store and
usage state with a database.

To generate traffic, `pnpm simulate` streams random events (~5/sec, mixed
`api.request` / `compute.done` / unmatched noise across a handful of fake
customers) at the ingestion endpoint until you Ctrl-C it. `EVENTS_PER_SECOND`
and `VOID_SERVER_URL` override the defaults.

## Dashboard

`pnpm dev` (or `pnpm --filter @void/web dev` alone) starts the dashboard on
[localhost:3001](http://localhost:3001). It subscribes to the server's SSE
stream, so usage updates the moment events are ingested (set `VOID_SERVER_URL`
if the server isn't on `localhost:4000`). It shows:

- **Usage** — aggregated meter values per customer, live.
- **Forecasts** — naive run-rate projection: usage velocity since the config
  was deployed, extrapolated over a 30-day period and priced per metered price
  (after the `included` allowance), plus a projected metered-revenue total.
- **Deployed configuration** — meters (filters + aggregations rendered back as
  DSL-ish text) and products with their prices, straight from the active IR.

Common commands: `pnpm build`, `pnpm test`, `pnpm typecheck` (all via Turborepo),
and `pnpm --filter @void/cli dev` to run the CLI from source.

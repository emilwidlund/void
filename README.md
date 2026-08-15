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
  entitlement sso
  entitlement seats { limit 5 }
  entitlement api_quota { meter api_calls limit 100_000 }
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

# Canonically format in place (--check for CI: exit 1 if unformatted)
node packages/cli/dist/bin.js fmt examples/pro.void

# Compile to JSON IR on stdout
node packages/cli/dist/bin.js build examples/pro.void

# Deploy the checksummed IR to a void server (built for CI/CD)
node packages/cli/dist/bin.js deploy examples/pro.void --endpoint http://localhost:4000/v1/deploy
node packages/cli/dist/bin.js deploy examples/pro.void --endpoint ... --dry-run   # print payload only
```

`deploy` POSTs `{ checksum, ir, meta }` where `checksum` is sha256 over the
canonical compact IR JSON — comment or formatting changes don't produce a new
version, so a server can no-op on an already-deployed checksum. `--endpoint`
is the full deploy URL; it and `--token` (sent as a bearer token) fall back to
the `VOID_ENDPOINT` / `VOID_TOKEN` environment variables. A compile error or
non-2xx response exits 1, so it drops straight into a CI/CD pipeline.

## Language

- **`meter <id> { ... }`** — aggregates ingested events into billable units.
  - `filter <expr>` — which events count. Comparisons (`==`, `!=`, `>`, `>=`,
    `<`, `<=`) over `event.*` properties, combined with `and` / `or` and
    parentheses (`and` binds tighter).
  - `aggregate <fn>` — `count`, or `sum|max|min|avg|unique(event.<property>)`.
  - `reverse_on <filter> [within <n> <time-unit>]` — outcome corrections:
    an event matching the reverse filter unwinds one prior charge on this
    meter (most recent first, only within the window when declared, never
    below zero). This is what makes pay-per-outcome pricing honest — a
    resolved ticket bills, a reopen within 7 days unbills it. Requires a
    `count` or `sum` aggregation (VOID123); the window must be a time span
    (VOID124). Reversals are matched by event `timestamp` when provided.
  - `unit <name>` — what one aggregated unit *is*. Units exist for
    dimensioned quantities — time (`ms`/`seconds`/`minutes`/`hours`/`days`)
    and data (`bytes`/`kb`/`mb`/`gb`/`tb`) — with conversion factors between
    them; everything countable (requests, tokens, seats) is the dimensionless
    **`scalar`** unit. Made-up unit names are compile errors (VOID122), and
    names are normalized (`seconds` ≡ `sec` ≡ `s`).
- **`product <id> { ... }`** — a sellable product.
  - `name "..."` — display name (required).
  - `price recurring <monthly|yearly|weekly|daily> <amount> <currency>`
  - `meter <id> { per_unit <amount> <currency>  included <n> }` — binds a
    top-level meter to the product with its usage pricing. The same meter can
    be priced differently by different products.

    `per_unit` takes an optional `per <unit>` suffix — `per_unit 3.6 USD per
    hour` on a meter that records seconds. The compiler checks dimensions:
    pricing bytes per hour is a compile error (VOID120), while same-dimension
    pairs auto-convert via a `unit_factor` in the IR (a ms meter priced per
    second divides usage by 1000 before charging). `included` allowances are
    in priced units. Pricing wrong-by-1000 unit bugs die at compile time —
    the kind of guarantee a billing dashboard can't give you.
  - `meter <id> { margin <pct>% }` — cost-derived pricing: instead of a fixed
    unit price, the charge is the meter's attributed `_cost` divided by
    `(1 - margin)`, so the configured gross margin holds whatever the units
    actually cost (the natural pricing for AI workloads with volatile
    upstream costs). Mutually exclusive with `per_unit`/`included`.
  - `entitlement <id>` — what the product grants beyond billing, in three
    forms: a bare `entitlement sso` is a boolean feature grant,
    `entitlement seats { limit 5 }` is a static numeric limit, and
    `entitlement api_quota { meter api_calls limit 100_000 }` is a usage cap
    checked against a top-level meter's live aggregation. Limits vary per
    product, so entitlements are declared inline rather than at the top level.
- **`outcome <id> { ... }`** — success-based billing as a correlated chain of
  events, declared at the top level like a meter:
  - `correlate event.<property>` — which event property identifies one
    instance of the outcome (a ticket id, a task id). Required (VOID140).
  - `step <filter>` — one link in the chain; steps must occur in declaration
    order for the same correlation key. At least one required (VOID141).
  - `fail_on <filter> [within <n> <time-unit>]` — aborts an in-flight chain,
    or reverses a *completed* one within the window — and because instances
    are correlated, a reopen reverses exactly its own ticket's charge.

  A completed chain counts one `scalar` unit of usage under the outcome's id,
  so outcomes price, gate and verify exactly like meters: products bind them
  with `outcome <id> { per_unit ... }` (margin pricing is rejected — VOID143;
  binding namespaces are checked — VOID142), entitlements can cap them, and
  invariants can put price floors on them.
- **`override customer "<id>" { ... }`** — a negotiated deal as config: meter
  price bindings and entitlements that replace the list versions for one
  customer, an optional replacement `price recurring ...` for the base fee,
  and an optional `until "2027-01-01"` expiry after which list pricing
  resumes. Overrides are held to the same static invariants as products — an
  enterprise discount below a declared price or margin floor fails the build
  (the deal desk cannot out-negotiate the config). Override entitlements
  replace same-id product grants and can add new ones on the entitlements
  endpoint.
- **`invariant "<name>" { <metric>(<subject>) <op> <threshold> }`** — a
  property the billing system must uphold, declared next to the pricing it
  constrains. Meter-scoped metrics are **compile-checked**: `price(api_calls)
  >= 5 USD_CENTS` and `margin(compute_seconds) >= 40%` are proven against
  every product at `void check` time, and a violation fails the build (so a
  price cut that breaks a floor dies in CI). Customer-scoped metrics are
  **runtime-monitored**: `spend(customer) <= 500 USD` and `margin(customer)
  >= 20%` ship in the IR and are evaluated against live billing state, with
  violations surfacing as alerts on the dashboard. A block may hold several
  conditions; each is checked independently.

  A condition takes an optional **`else <behavior>`** — the remedy applied
  when it's violated. Behaviors are remedies, not suppressions: the violation
  still surfaces, alongside a record of the remedy. `else warn` softens a
  compile-checked violation to a warning (the incremental-adoption path);
  `else cap` clamps the period bill at the threshold (the base bills first,
  usage charges absorb the clamp — the lowest applicable cap wins); `else
  block` flips `enforcement` to `"blocked"` on the entitlements endpoint so
  the application can stop serving the customer; `else notify` emits an
  alert. The checker enforces a validity matrix — compile-checked invariants
  only take `warn`, `margin(customer)` takes `warn`/`notify` (you can't cap
  your way out of your own costs), `spend(customer)` takes all four —
  rejecting nonsense combos like `price(m) else cap` at compile time.
- **Money** — `29.99 USD` is major units; a `_CENTS` suffix (`10 USD_CENTS`)
  means minor units. The IR normalizes everything to decimal strings in minor
  units, so sub-cent unit prices stay exact (`0.001 USD` → `"0.1"` cents).
- Comments start with `#`. Numbers may use `_` separators (`10_000`).
- **`void fmt`** rewrites a file into canonical form: consistent indentation
  and spacing, `_`-grouped numbers (five digits and up), single-field blocks
  inlined (`entitlement seats { limit 5 }`), one blank line between
  declarations, blank-line grouping and all comments preserved. Formatting
  only requires a parse, so files with semantic errors still format.
- **Editor support** — `@void/lsp` is a language server (diagnostics as you
  type, context-aware completion, go-to-definition and hover for meter
  references), and `editors/vscode` is a VS Code extension that bundles it
  with syntax highlighting for `.void` files (money, percentages, filter
  expressions, behaviors), `#` comment toggling and bracket pairs. See
  `editors/vscode/README.md` for install instructions; the server also works
  with any LSP-capable editor via `void-lsp --stdio`.

## Workspace

| Package | Purpose |
| --- | --- |
| `@void/compiler` | Lexer → parser → checker → IR emitter, span-based diagnostics, IR schema. Built on [Effect](https://effect.website). |
| `@void/cli` | `void` CLI (`init`, `check`, `build`, `deploy`, `fmt`) built on `@effect/cli`. |
| `@void/lsp` | Language server: live diagnostics, completion, go-to-definition, hover. |
| `@void/server` | Void server: accepts deploys, ingests events, runs meter aggregation. |
| `@void/web` | Next.js dashboard (`apps/web`): live earnings, projections, per-customer spend. |

## Server

`pnpm dev` starts the server and dashboard together (via Turborepo). To run
just the server: `pnpm --filter @void/server dev` (`PORT`, default 4000).
Endpoints:

- `POST /v1/deploy` — accepts `{ checksum, ir, meta }` from `void deploy`. The
  IR is parsed with the compiler's schema and the checksum re-verified (400 on
  mismatch); an already-active checksum is a no-op (200 `unchanged`), otherwise
  a new config version is stored (201 `accepted`).
- `POST /v1/events` — batch event ingestion: `{ "events": [{ "name": "api.request",
  "external_customer_id": "acme", "properties": { ... } }] }`. Every event is
  evaluated against each meter's filter and folded into its aggregation
  (count/sum/max/min/avg/unique), keyed per customer (`anonymous` when no
  customer id is given). Events matching a meter's `reverse_on` filter unwind
  a prior charge instead of adding one. Responds 202 with per-meter `matched`
  and `reversed` counts, or 409 if no config has been deployed yet.

  Events may carry an optional **`_cost`** — what serving the event cost you:
  `"_cost": { "amount": 0.0042, "currency": "USD" }` (amount in major units,
  the natural shape for AI/LLM workloads). Costs accumulate per customer and
  event name regardless of whether any meter matches, and are additionally
  attributed to every meter whose filter matches the event (overlapping
  meters double-count) — that attribution is what `margin` pricing bills
  against. They power the dashboard's margin analytics.
- `GET /v1/usage` — aggregated usage per meter and customer, plus accumulated
  `_cost` per customer and event name, and per meter (in minor units).
- `GET /v1/entitlements/:customer` — resolves the customer's entitlements from
  the active config: flags and limits as declared, and metered entitlements
  with live `used` / `remaining` / `exceeded` computed from that customer's
  usage. Also the enforcement surface for invariants: the response carries
  `violations` (customer-scoped `spend` invariants currently violated, with
  their remedies) and `enforcement: "ok" | "blocked"` — `"blocked"` when a
  violated invariant carries `else block`, telling the application to stop
  serving the customer. With no subscription data yet, a customer is
  attributed to a product when they have usage on one of its metered meters
  (the same heuristic the dashboard uses). 409 if no config is deployed.
- `GET /v1/config` — the active config version.
- `GET /v1/stream` — server-sent events: a full `{ usage, config, history,
  costs, meter_costs }` snapshot on connect, then one per ingested batch or
  deploy (the dashboard's live feed). `history` is the last 600 change-points
  of usage and cost, which powers the dashboard's charts.
- `GET /health` — liveness check.

State is in-memory for now — a real deployment would back the config store and
usage state with a database.

To generate traffic, `pnpm simulate` streams random events (~5/sec, mixed
`api.request` / `compute.done` / unmatched noise across a handful of fake
customers) at the ingestion endpoint until you Ctrl-C it. Compute events carry
a GPU-second `_cost` and some API requests carry an LLM-ish `_cost`, so the
margin analytics light up out of the box. `EVENTS_PER_SECOND` and
`VOID_SERVER_URL` override the defaults.

## Dashboard

`pnpm dev` (or `pnpm --filter @void/web dev` alone) starts the dashboard on
[localhost:3001](http://localhost:3001). It subscribes to the server's SSE
stream through a `/api/void/*` proxy route, so usage updates the moment events
are ingested (set `VOID_SERVER_URL` on the web process if the server isn't on
`localhost:4000` — it's read at request time, never baked into the build or
exposed to the browser). The overview shows:

- **Earnings & margins** — usage charges accrued so far and a projection for
  the month, as a headline sentence, KPI tiles (usage earnings, expected this
  month, subscription base, paying customers — plus cost so far and gross
  margin when events report `_cost`), and an earnings-over-time chart with a
  cost overlay.
- **Insights** — auto-generated highlights: revenue concentration in a top
  customer, customers past their included allowance and billing overage,
  recent earning-pace changes, metered usage no product prices, customers
  whose costs exceed their revenue, and thin or healthy overall gross margin.
- **Customers** — spend and margin per customer, each linking to a detail page
  (`/customers/<id>`) with that customer's own KPIs (including cost and gross
  margin), earnings-vs-cost chart, cost-by-event breakdown, meter breakdown,
  and usage activity.
- **Usage activity** — per-meter volume sparklines across all customers.
- **Invariant violations** — customer-scoped invariants from the deployed
  config are evaluated against live spend and margins; violations show as
  alert banners at the top of the overview, annotated with the applied remedy
  (capped, blocked, notified). `else cap` ceilings actually clamp the spend
  model's billed and projected figures — capped bills are judged against
  uncapped spend so the violation stays visible — and an insight reports the
  revenue absorbed by caps.
- **Billing configuration** — a collapsible panel with the active version's
  meters (filters + aggregations rendered back as DSL-ish text), products
  with their prices, and declared invariants (tagged compile-checked or
  live), straight from the deployed IR.

The spend model is deliberately naive while the config has no subscription
data: a customer is attributed to a product when they have usage on one of its
metered meters, which contributes that product's recurring fees (normalized to
a 30-day period) as their base. Metered spend prices usage beyond each
`included` allowance, and projections extrapolate the run rate observed since
the config was deployed. Gross margin compares projected revenue (base +
metered) against reported `_cost` extrapolated at the same run rate; costs in
a different currency than pricing are flagged in insights but not converted.
Margin-priced meters charge attributed cost / (1 - margin), so their gross
margin holds by construction. Customers that only report costs still appear —
they're pure loss.

Common commands: `pnpm build`, `pnpm test`, `pnpm typecheck` (all via Turborepo),
and `pnpm --filter @void/cli dev` to run the CLI from source.

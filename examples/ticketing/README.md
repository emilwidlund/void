# helpdesk — a support ticketing app billed by void

A Next.js demo showing the whole void stack in one product: the billing
model is code (`void.ts`), the app talks to a **local proxy** (instant
entitlement/enforcement checks, durable store-and-forward), and the parent
server + dashboard run alongside.

## Run it

```sh
pnpm install && pnpm build       # once, from the repo root
pnpm --filter void-ticketing-demo dev
```

One command boots everything, in order:

1. **parent void server** on :4000 — the "hosted" billing backend
2. **billing dashboard** on :3001 — live earnings, margins, invariants
3. **deploys `void.ts`** to the parent (checksum-idempotent)
4. **void proxy** on :4010 — the merchant sidecar; journal in `.void-proxy/`
5. **the helpdesk** on http://localhost:3005

## What to try

- **Open a ticket** → `ticket.opened` starts the `ticket_resolution` outcome
  chain for that ticket id.
- **🤖 AI reply** → a real model call through `voidClient.ai.agent` — the
  `agent` meter declared with `metered(...)` in `void.ts` tracks `ai.agent`
  with token counts and its `_cost` automatically, and expands into
  per-token-class meters (`agent.input_tokens` / `.cached_input_tokens` /
  `.output_tokens`); each reply is billed at a **70% margin** over the model
  cost. Gated on the `ai_agent` entitlement and a live `reply_quota` (200/mo
  — acme negotiated 500). Runs offline on a simulated model; set
  `AI_GATEWAY_API_KEY` to route it through the Vercel AI Gateway for real.
- **Resolve** → completes the chain: **$1.50 per resolved ticket** ($1 for
  acme, via their override). Watch it land on the dashboard.
- **Reopen** → fails the chain and unwinds exactly that ticket's charge —
  outcome corrections, correlated per ticket.
- **Kill the parent server** (`kill` the :4000 process) → the app keeps
  working: entitlements, quotas and enforcement are answered by the proxy;
  the backlog counter climbs; restart the parent and watch it drain.
- Spam AI replies long enough and the **bill-shock invariants** trip: bills
  cap at $200, and at $400 uncapped spend the workspace is **blocked** — the
  banner in the app is reading real enforcement state from the proxy.

## Production-shaped hosting

`docker-compose.yml` runs the proxy the way a merchant would — containerized
with a persistent volume, pointed at a remote parent:

```sh
VOID_UPSTREAM=https://billing.example.com \
  docker compose -f examples/ticketing/docker-compose.yml up -d
```

Then run the app with `VOID_PROXY_URL=http://localhost:4012 pnpm --filter
void-ticketing-demo app`.

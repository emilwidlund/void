# Examples

| Path | What it shows |
| --- | --- |
| `pro.void` | The reference billing config in the void DSL — meters, an outcome chain, entitlements, margin pricing, invariants with behaviors, a customer override. CI validates and deploys this file (`scripts/billing-ci.sh`). |
| `pro.ts` | The same config through `@void/sdk`'s `defineConfig` — compiles to byte-identical IR. |
| `void.ts` | An app's `void.ts`: the customer state of record with a first-class `ai` section — AI Gateway models metered through `@void/sdk/ai`, cost-plus pricing and a margin invariant fed by automatic `_cost`. |
| `ticketing/` | A full demo application: a Next.js support helpdesk billed end-to-end through void — outcome pricing per resolved ticket, cost-plus AI replies, entitlement gating, invariant enforcement, all via a local proxy. See its README. |

## Running the ticketing demo

```sh
pnpm install && pnpm build
pnpm --filter void-ticketing-demo dev
```

That single command boots the parent void server (:4000), the billing
dashboard (:3001), deploys `ticketing/billing.ts`, starts the merchant-side
proxy (:4010), and serves the helpdesk at http://localhost:3005.

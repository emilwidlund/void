import { formatAggregation, formatFilter, formatMoney } from "../lib/format"
import { formatInvariant } from "../lib/invariants"
import type { ActiveConfig } from "../lib/types"

const entity = "flex flex-col gap-1 border-b border-hairline py-3.5 last:border-b-0 last:pb-0 first:pt-0"

export function ConfigPanel({ config }: { readonly config: ActiveConfig }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] gap-3">
      <div className="bg-surface p-5">
        <h3 className="mb-3 text-ink-strong">
          Meters <span className="text-[13.5px] text-ink-muted">{config.ir.meters.length}</span>
        </h3>
        {config.ir.meters.map((meter) => (
          <div className={entity} key={meter.id}>
            <div className="flex items-center gap-2.5 text-ink-strong">
              <span className="font-mono text-[13px]">{meter.id}</span>
              <span className="bg-surface-2 px-1.5 font-mono text-[12px] text-ink-muted">
                {formatAggregation(meter.aggregation)}
              </span>
              {meter.unit ? (
                <span className="bg-surface-2 px-1.5 font-mono text-[12px] text-ink-muted">
                  {meter.unit}s
                </span>
              ) : null}
            </div>
            <div className="font-mono text-[12.5px] text-ink-muted">
              {formatFilter(meter.filter)}
            </div>
          </div>
        ))}
      </div>
      <div className="bg-surface p-5">
        <h3 className="mb-3 text-ink-strong">
          Products{" "}
          <span className="text-[13.5px] text-ink-muted">{config.ir.products.length}</span>
        </h3>
        {config.ir.products.map((product) => (
          <div className={entity} key={product.id}>
            <div className="flex items-center gap-2.5 text-ink-strong">
              {product.name}{" "}
              <span className="font-mono text-[13px] text-ink-muted">({product.id})</span>
            </div>
            {product.entitlements.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 pb-1">
                {product.entitlements.map((entitlement) => (
                  <span
                    className="bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-ink-muted"
                    key={entitlement.id}
                  >
                    {entitlement.type === "flag"
                      ? entitlement.id
                      : entitlement.type === "limit"
                        ? `${entitlement.id} ≤ ${entitlement.limit.toLocaleString("en-US")}`
                        : `${entitlement.id} · ${entitlement.meter} ≤ ${entitlement.limit.toLocaleString("en-US")}`}
                  </span>
                ))}
              </div>
            ) : null}
            {product.prices.map((price, index) => (
              <div className="flex justify-between gap-3 text-[14px]" key={index}>
                {price.type === "recurring" ? (
                  <>
                    <span className="text-ink-muted">recurring / {price.interval}</span>
                    <span>{formatMoney(price.amount)}</span>
                  </>
                ) : price.type === "metered" ? (
                  <>
                    <span className="text-ink-muted">
                      metered · <span className="font-mono text-[13px]">{price.meter}</span>
                      {price.included_units > 0
                        ? ` · ${price.included_units.toLocaleString("en-US")} included`
                        : ""}
                    </span>
                    <span>
                      {formatMoney(price.per_unit)} / {price.per ?? "unit"}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="text-ink-muted">
                      cost-plus ·{" "}
                      <span className="font-mono text-[13px]">{price.meter}</span>
                    </span>
                    <span>{Math.round(price.margin * 100)}% margin</span>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      {config.ir.invariants.length > 0 ? (
        <div className="bg-surface p-5">
          <h3 className="mb-3 text-ink-strong">
            Invariants{" "}
            <span className="text-[13.5px] text-ink-muted">
              {config.ir.invariants.length}
            </span>
          </h3>
          {config.ir.invariants.map((invariant, index) => (
            <div className={entity} key={index}>
              <div className="text-ink-strong">{invariant.name}</div>
              <div className="flex items-center gap-2.5">
                <span className="font-mono text-[12.5px] text-ink-muted">
                  {formatInvariant(invariant)}
                </span>
                <span className="bg-surface-2 px-1.5 font-mono text-[12px] text-ink-muted">
                  {invariant.meter !== null ? "compile-checked" : "live"}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

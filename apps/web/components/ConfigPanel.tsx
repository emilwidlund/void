import { formatAggregation, formatFilter, formatMoney } from "../lib/format"
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
            {product.prices.map((price, index) => (
              <div className="flex justify-between gap-3 text-[14px]" key={index}>
                {price.type === "recurring" ? (
                  <>
                    <span className="text-ink-muted">recurring / {price.interval}</span>
                    <span>{formatMoney(price.amount)}</span>
                  </>
                ) : (
                  <>
                    <span className="text-ink-muted">
                      metered · <span className="font-mono text-[13px]">{price.meter}</span>
                      {price.included_units > 0
                        ? ` · ${price.included_units.toLocaleString("en-US")} included`
                        : ""}
                    </span>
                    <span>{formatMoney(price.per_unit)} / unit</span>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

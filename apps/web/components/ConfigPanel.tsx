import { formatAggregation, formatFilter, formatMoney } from "../lib/format"
import type { ActiveConfig } from "../lib/types"

export function ConfigPanel({ config }: { readonly config: ActiveConfig }) {
  return (
    <div className="grid-2">
      <div className="card">
        <h2>
          Meters <small>{config.ir.meters.length}</small>
        </h2>
        {config.ir.meters.map((meter) => (
          <div className="entity" key={meter.id}>
            <div className="entity-name">
              <span className="mono">{meter.id}</span>
              <span className="badge">{formatAggregation(meter.aggregation)}</span>
            </div>
            <div className="entity-detail">{formatFilter(meter.filter)}</div>
          </div>
        ))}
      </div>
      <div className="card">
        <h2>
          Products <small>{config.ir.products.length}</small>
        </h2>
        {config.ir.products.map((product) => (
          <div className="entity" key={product.id}>
            <div className="entity-name">
              {product.name} <span className="mono muted">({product.id})</span>
            </div>
            {product.prices.map((price, index) => (
              <div className="price-line" key={index}>
                {price.type === "recurring" ? (
                  <>
                    <span className="muted">recurring / {price.interval}</span>
                    <span>{formatMoney(price.amount)}</span>
                  </>
                ) : (
                  <>
                    <span className="muted">
                      metered · <span className="mono">{price.meter}</span>
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

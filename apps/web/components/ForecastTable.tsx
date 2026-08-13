import { formatMoney, formatUnits } from "../lib/format"
import type { MeterForecast } from "../lib/forecast"
import { PERIOD_DAYS } from "../lib/forecast"

export function ForecastTable({
  forecasts
}: {
  readonly forecasts: ReadonlyArray<MeterForecast>
}) {
  if (forecasts.length === 0) {
    return (
      <div className="card empty">Forecasts appear once metered prices see usage</div>
    )
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Meter</th>
            <th>Customer</th>
            <th className="num">Current</th>
            <th className="num">Projected / {PERIOD_DAYS}d</th>
            <th className="num">Included</th>
            <th className="num">Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {forecasts.map((f) => (
            <tr key={`${f.product}:${f.meter}:${f.customer}`}>
              <td>{f.productName}</td>
              <td className="mono">{f.meter}</td>
              <td>{f.customer}</td>
              <td className="num">{formatUnits(f.currentUnits)}</td>
              <td className="num">{formatUnits(Math.round(f.projectedUnits))}</td>
              <td className="num muted">{formatUnits(f.includedUnits)}</td>
              <td className="num cost">
                {formatMoney({ currency: f.currency, amount: String(f.projectedCostMinor) })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

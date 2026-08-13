import { formatUnits } from "../lib/format"
import type { UsageRow } from "../lib/types"

export function UsageTable({ usage }: { readonly usage: ReadonlyArray<UsageRow> }) {
  if (usage.length === 0) {
    return (
      <div className="card empty">
        No usage yet — ingest events with <code>POST /v1/events</code>
      </div>
    )
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Meter</th>
            <th>Customer</th>
            <th>Aggregation</th>
            <th className="num">Value</th>
          </tr>
        </thead>
        <tbody>
          {usage.map((row) => (
            <tr key={`${row.meter}:${row.customer}`}>
              <td className="mono">{row.meter}</td>
              <td>{row.customer}</td>
              <td>
                <span className="badge">{row.aggregation}</span>
              </td>
              <td className="num">{formatUnits(row.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

import Link from "next/link"
import { formatMinor } from "../lib/format"
import type { CustomerSpend } from "../lib/spend"
import { Code, Empty } from "./Empty"

const cell = "border-b border-hairline px-4.5 py-3 whitespace-nowrap"

function StatusChip({ customer }: { readonly customer: CustomerSpend }) {
  const over = customer.lines.some(
    (line) => line.includedUsed !== null && line.includedUsed > 1
  )
  if (customer.lines.length === 0) {
    return <span className="text-ink-faint">subscription only</span>
  }
  return over ? (
    <span className="text-ok">billing overage</span>
  ) : (
    <span className="text-ink-muted">within allowance</span>
  )
}

export function CustomerTable({
  customers
}: {
  readonly customers: ReadonlyArray<CustomerSpend>
}) {
  if (customers.length === 0) {
    return (
      <Empty>
        No customer usage yet — run <Code>pnpm simulate</Code> or ingest events with{" "}
        <Code>POST /v1/events</Code>
      </Empty>
    )
  }

  const maxProjected = Math.max(...customers.map((c) => c.projectedMinor), 1)

  return (
    <div className="overflow-x-auto bg-surface">
      <table className="w-full border-collapse text-[14.5px] tabular-nums [&_tr:last-child_td]:border-b-0">
        <thead>
          <tr className="text-left text-[13px] text-ink-muted">
            <th className={cell}>Customer</th>
            <th className={cell}>Plan</th>
            <th className={cell}>Status</th>
            <th className={`${cell} text-right`}>Expected this month</th>
            <th className={`${cell} text-right`}>Margin</th>
            <th className={`${cell} w-[130px]`}>Share</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((customer) => (
            <tr key={customer.customer} className="text-ink-strong">
              <td className={cell}>
                <Link
                  className="group"
                  href={`/customers/${encodeURIComponent(customer.customer)}`}
                >
                  {customer.customer}{" "}
                  <span className="text-ink-faint transition-colors group-hover:text-ink-strong">
                    →
                  </span>
                </Link>
              </td>
              <td className={`${cell} text-ink-muted`}>
                {customer.products.join(", ") || "—"}
              </td>
              <td className={`${cell} text-[13.5px]`}>
                <StatusChip customer={customer} />
              </td>
              <td className={`${cell} text-right`}>
                {formatMinor(customer.projectedMinor, customer.currency)}
              </td>
              <td className={`${cell} text-right`}>
                {customer.marginPct === null || customer.projectedCostMinor === 0 ? (
                  <span className="text-ink-faint">—</span>
                ) : (
                  <span className={customer.marginPct < 0 ? "text-bad" : "text-ink-muted"}>
                    {Math.round(customer.marginPct * 100)}%
                  </span>
                )}
              </td>
              <td className={cell}>
                <span className="block h-1.5 bg-bar">
                  <span
                    className="block h-full min-w-[2px] bg-fill"
                    style={{ width: `${(customer.projectedMinor / maxProjected) * 100}%` }}
                  />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

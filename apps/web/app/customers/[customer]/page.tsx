"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { useMemo } from "react"
import { Code, Empty } from "../../../components/Empty"
import { MeterSparklines } from "../../../components/MeterSparklines"
import { RevenueChart } from "../../../components/RevenueChart"
import { formatApprox, formatMinor, formatUnits, shortChecksum } from "../../../lib/format"
import { filterHistory, meterSeries, revenueSeries } from "../../../lib/series"
import { computeSpend } from "../../../lib/spend"
import { useDashboard } from "../../../lib/useDashboard"

const sectionTitle = "mb-3 flex items-baseline gap-3 text-[17px] text-ink-strong"
const sectionHint = "text-[13.5px] text-ink-muted"
const kpi = "bg-surface p-5"
const kpiLabel = "text-[13.5px] text-ink-muted"
const kpiValue = "mt-2 text-[32px] text-ink-strong tabular-nums"
const cell = "border-b border-hairline px-4.5 py-3 whitespace-nowrap"

export default function CustomerPage() {
  const params = useParams<{ customer: string }>()
  const customer = decodeURIComponent(params.customer)
  const { data, error, lastUpdated } = useDashboard()

  const spend = useMemo(
    () =>
      data?.config
        ? computeSpend(data.usage, data.config.ir, data.config.deployed_at, new Date())
        : null,
    [data]
  )
  const detail = spend?.customers.find((c) => c.customer === customer)

  const customerHistory = useMemo(
    () => (data ? filterHistory(data.history, customer) : []),
    [data, customer]
  )
  const revenue = useMemo(
    () =>
      data?.config
        ? revenueSeries(customerHistory, data.config.ir, data.config.deployed_at)
        : [],
    [customerHistory, data]
  )
  const meters = useMemo(() => meterSeries(customerHistory), [customerHistory])

  const healthy = error === null && data !== null
  const currency = detail?.currency ?? spend?.totals.currency ?? "USD"
  const share =
    detail !== undefined && spend !== null && spend.totals.projectedMinor > 0
      ? detail.projectedMinor / spend.totals.projectedMinor
      : null

  return (
    <main className="mx-auto flex max-w-[1120px] flex-col gap-10 px-8 pb-24 pt-10">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-hairline pb-5">
        <div className="flex items-baseline gap-4">
          <Link href="/" className="text-[14px] text-ink-muted transition-colors hover:text-ink">
            ← void
          </Link>
          <div className="text-lg text-ink-strong">{customer}</div>
        </div>
        <div className="flex items-center gap-5 text-[13px] text-ink-muted">
          {data?.config ? (
            <span className="font-mono">
              v{data.config.version} · {shortChecksum(data.config.checksum)}
            </span>
          ) : null}
          {lastUpdated ? <span>updated {lastUpdated.toLocaleTimeString()}</span> : null}
          <span
            className={`flex items-center gap-2 bg-surface-2 px-2.5 py-1 text-[12px] ${
              healthy ? "text-ok" : "text-bad"
            }`}
          >
            <span className="size-1.5 bg-current" />
            {healthy ? "live" : "reconnecting"}
          </span>
        </div>
      </header>

      {data && detail === undefined ? (
        <Empty>
          No usage recorded for <Code>{customer}</Code> this period
        </Empty>
      ) : null}

      {detail ? (
        <>
          <p className="max-w-[52rem] text-[22px] leading-relaxed text-ink-muted">
            <span className="text-ink-strong">{customer}</span> has spent{" "}
            <span className="text-ink-strong">
              {formatMinor(detail.accruedMinor + detail.baseMinor, currency)}
            </span>{" "}
            so far and is on pace for about{" "}
            <span className="text-ink-strong">
              {formatApprox(detail.projectedMinor, currency)}
            </span>{" "}
            this month
            {share !== null ? (
              <>
                {" "}
                — <span className="text-ink-strong">{(share * 100).toFixed(1)}%</span> of
                your expected revenue
              </>
            ) : null}
            .
          </p>

          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
            <div className={kpi}>
              <div className={kpiLabel}>Plan</div>
              <div className="mt-2 text-[22px] text-ink-strong">
                {detail.products.join(", ") || "—"}
              </div>
            </div>
            <div className={kpi}>
              <div className={kpiLabel}>Usage charges so far</div>
              <div className={kpiValue}>{formatMinor(detail.accruedMinor, currency)}</div>
            </div>
            <div className={kpi}>
              <div className={kpiLabel}>Expected this month</div>
              <div className={kpiValue}>{formatApprox(detail.projectedMinor, currency)}</div>
            </div>
            <div className={kpi}>
              <div className={kpiLabel}>Subscription base</div>
              <div className={kpiValue}>{formatApprox(detail.baseMinor, currency)}</div>
            </div>
          </div>

          <section>
            <h2 className={sectionTitle}>
              Their usage charges
              <span className={sectionHint}>as they accrued over time</span>
            </h2>
            <RevenueChart currency={currency} series={revenue} />
          </section>

          <section>
            <h2 className={sectionTitle}>
              What they&apos;re using
              <span className={sectionHint}>per meter, with allowances</span>
            </h2>
            <div className="mb-3">
              <MeterSparklines series={meters} />
            </div>
            <div className="overflow-x-auto bg-surface">
              <table className="w-full border-collapse text-[14.5px] tabular-nums [&_tr:last-child_td]:border-b-0">
                <thead>
                  <tr className="text-left text-[13px] text-ink-muted">
                    <th className={cell}>Meter</th>
                    <th className={cell}>Usage</th>
                    <th className={`${cell} text-right`}>Allowance used</th>
                    <th className={`${cell} text-right`}>Per unit</th>
                    <th className={`${cell} text-right`}>Charged</th>
                    <th className={`${cell} text-right`}>Expected</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((line) => (
                    <tr key={`${line.product}:${line.meter}`}>
                      <td className={cell}>
                        <span className="font-mono text-[13px]">{line.meter}</span>{" "}
                        <span className="bg-surface-2 px-1.5 font-mono text-[12px] text-ink-muted">
                          {line.aggregation}
                        </span>
                      </td>
                      <td className={cell}>
                        {formatUnits(line.units)}
                        {line.includedUnits > 0 ? (
                          <span className="text-ink-muted">
                            {" "}
                            of {formatUnits(line.includedUnits)} included
                          </span>
                        ) : null}
                      </td>
                      <td className={`${cell} text-right`}>
                        {line.includedUsed === null ? (
                          <span className="text-ink-faint">—</span>
                        ) : (
                          <span
                            className={line.includedUsed > 1 ? "text-ok" : "text-ink-muted"}
                          >
                            {Math.round(line.includedUsed * 100)}%
                          </span>
                        )}
                      </td>
                      <td className={`${cell} text-right text-ink-muted`}>
                        {formatMinor(line.perUnitMinor, currency)}
                      </td>
                      <td className={`${cell} text-right`}>
                        {formatMinor(line.accruedMinor, currency)}
                      </td>
                      <td className={`${cell} text-right text-ink-strong`}>
                        {formatMinor(line.projectedMinor, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </main>
  )
}

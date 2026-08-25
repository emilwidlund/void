"use client"

import { useMemo } from "react"
import { ConfigPanel } from "../components/ConfigPanel"
import { CustomerTable } from "../components/CustomerTable"
import { Code, Empty } from "../components/Empty"
import { MeterSparklines } from "../components/MeterSparklines"
import { RevenueChart } from "../components/RevenueChart"
import { formatApprox, formatMinor, shortChecksum } from "../lib/format"
import { highlights } from "../lib/insights"
import { evaluateInvariants } from "../lib/invariants"
import { meterSeries, revenueSeries } from "../lib/series"
import { computeSpend } from "../lib/spend"
import { useDashboard } from "../lib/useDashboard"

const sectionTitle = "mb-3 flex items-baseline gap-3 text-[17px] text-ink-strong"
const sectionHint = "text-[13.5px] text-ink-muted"
const kpi = "bg-surface p-5"

export default function Dashboard() {
  const { data, error, lastUpdated } = useDashboard()

  const spend = useMemo(
    () =>
      data?.config
        ? computeSpend(
            data.usage,
            data.config.ir,
            data.config.deployed_at,
            new Date(),
            data.costs,
            data.meter_costs
          )
        : null,
    [data]
  )
  const revenue = useMemo(
    () =>
      data?.config
        ? revenueSeries(data.history, data.config.ir, data.config.deployed_at)
        : [],
    [data]
  )
  const meters = useMemo(() => (data ? meterSeries(data.history) : []), [data])
  const insights = useMemo(
    () =>
      spend !== null && data?.config
        ? highlights(spend, data.usage, data.config.ir, revenue)
        : [],
    [spend, data, revenue]
  )
  const violations = useMemo(
    () =>
      spend !== null && data?.config
        ? evaluateInvariants(data.config.ir.invariants, spend)
        : [],
    [spend, data]
  )

  const healthy = error === null && data !== null
  const currency = spend?.totals.currency ?? "USD"
  const customerCount = spend?.customers.length ?? 0

  return (
    <main className="mx-auto flex max-w-[1120px] flex-col gap-10 px-8 pb-24 pt-10">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-hairline pb-5">
        <div className="text-lg text-ink-strong">void</div>
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

      {error !== null && data === null ? (
        <Empty>
          Can&apos;t reach the void server ({error}) — start everything with{" "}
          <Code>pnpm dev</Code>
        </Empty>
      ) : null}

      {data && spend ? (
        <>
          {customerCount > 0 ? (
            <p className="max-w-[52rem] text-[22px] leading-relaxed text-ink-muted">
              You&apos;ve earned{" "}
              <span className="text-ink-strong">
                {formatMinor(spend.totals.accruedMinor, currency)}
              </span>{" "}
              from usage so far. With subscriptions included, you&apos;re on pace for
              about{" "}
              <span className="text-ink-strong">
                {formatApprox(spend.totals.projectedMinor, currency)}
              </span>{" "}
              this month across{" "}
              <span className="text-ink-strong">
                {customerCount} customer{customerCount === 1 ? "" : "s"}
              </span>
              {spend.totals.marginPct !== null && spend.totals.projectedCostMinor > 0 ? (
                <>
                  , at a{" "}
                  <span
                    className={spend.totals.marginPct < 0 ? "text-bad" : "text-ink-strong"}
                  >
                    {Math.round(spend.totals.marginPct * 100)}% gross margin
                  </span>
                </>
              ) : null}
              .
            </p>
          ) : null}

          {violations.length > 0 ? (
            <div className="flex flex-col gap-2">
              {violations.map((violation) => (
                <div
                  className="flex items-baseline gap-2.5 bg-surface px-4 py-3 text-[14px]"
                  key={`${violation.name}:${violation.text}`}
                >
                  <span className="size-1.5 shrink-0 self-center bg-bad" />
                  <span className="text-bad">
                    invariant &ldquo;{violation.name}&rdquo; violated
                  </span>
                  <span className="text-ink-muted">{violation.text}</span>
                </div>
              ))}
            </div>
          ) : null}

          {insights.length > 0 ? (
            <div className="flex flex-wrap gap-3">
              {insights.map((item) => (
                <div
                  className="flex items-center gap-2.5 bg-surface px-4 py-3 text-[14px]"
                  key={item.text}
                >
                  <span
                    className={`size-1.5 shrink-0 ${
                      item.tone === "ok"
                        ? "bg-ok"
                        : item.tone === "warn"
                          ? "bg-bad"
                          : "bg-ink-muted"
                    }`}
                  />
                  {item.text}
                </div>
              ))}
            </div>
          ) : null}

          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
            <div className={kpi}>
              <div className="text-[13.5px] text-ink-muted">Usage revenue so far</div>
              <div className="mt-2 text-[32px] text-ink-strong tabular-nums">
                {formatMinor(spend.totals.accruedMinor, currency)}
              </div>
            </div>
            <div className={kpi}>
              <div className="text-[13.5px] text-ink-muted">
                Expected revenue this month
              </div>
              <div className="mt-2 text-[32px] text-ink-strong tabular-nums">
                {formatApprox(spend.totals.projectedMinor, currency)}
              </div>
            </div>
            <div className={kpi}>
              <div className="text-[13.5px] text-ink-muted">From subscriptions</div>
              <div className="mt-2 text-[32px] text-ink-strong tabular-nums">
                {formatApprox(spend.totals.baseMinor, currency)}
              </div>
            </div>
            {spend.totals.costMinor > 0 ? (
              <>
                <div className={kpi}>
                  <div className="text-[13.5px] text-ink-muted">
                    Your costs so far
                  </div>
                  <div className="mt-2 text-[32px] text-ink-strong tabular-nums">
                    {formatMinor(spend.totals.costMinor, currency)}
                  </div>
                </div>
                <div className={kpi}>
                  <div className="text-[13.5px] text-ink-muted">Gross margin</div>
                  <div
                    className={`mt-2 text-[32px] tabular-nums ${
                      spend.totals.marginPct !== null && spend.totals.marginPct < 0
                        ? "text-bad"
                        : "text-ink-strong"
                    }`}
                  >
                    {spend.totals.marginPct === null
                      ? "—"
                      : `${Math.round(spend.totals.marginPct * 100)}%`}
                  </div>
                </div>
              </>
            ) : null}
            <div className={kpi}>
              <div className="text-[13.5px] text-ink-muted">Paying customers</div>
              <div className="mt-2 text-[32px] text-ink-strong tabular-nums">
                {customerCount}
              </div>
            </div>
          </div>

          <section>
            <h2 className={sectionTitle}>
              Revenue vs cost
              <span className={sectionHint}>
                what customers are billed vs the costs your events report
              </span>
            </h2>
            <RevenueChart currency={currency} series={revenue} />
          </section>

          <section>
            <h2 className={sectionTitle}>Customers</h2>
            <CustomerTable customers={spend.customers} />
          </section>

          <section>
            <h2 className={sectionTitle}>
              Usage activity
              <span className={sectionHint}>volume per meter, all customers combined</span>
            </h2>
            <MeterSparklines series={meters} />
          </section>

          <details className="group">
            <summary className="cursor-pointer list-none bg-surface px-5 py-4 text-ink-muted transition-colors hover:text-ink">
              <span className="mr-2 inline-block transition-transform group-open:rotate-90">
                ›
              </span>
              Billing configuration — v{data.config?.version} ·{" "}
              {data.config?.meters ?? 0} meters · {data.config?.products ?? 0} products
              {data.config?.source ? ` · ${data.config.source}` : ""}
            </summary>
            <div className="mt-3">
              {data.config ? <ConfigPanel config={data.config} /> : null}
            </div>
          </details>
        </>
      ) : null}

      {data && !data.config ? (
        <Empty>
          No billing configuration deployed — run <Code>void deploy billing.void</Code>
        </Empty>
      ) : null}
    </main>
  )
}

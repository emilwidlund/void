"use client"

import { useMemo } from "react"
import { ConfigPanel } from "../components/ConfigPanel"
import { ForecastTable } from "../components/ForecastTable"
import { UsageTable } from "../components/UsageTable"
import { forecastUsage, PERIOD_DAYS } from "../lib/forecast"
import { formatMoney, shortChecksum } from "../lib/format"
import { useDashboard } from "../lib/useDashboard"

export default function Dashboard() {
  const { data, error, lastUpdated } = useDashboard()

  const forecasts = useMemo(
    () =>
      data?.config
        ? forecastUsage(data.usage, data.config.ir, data.config.deployed_at, new Date())
        : [],
    [data]
  )

  const customers = data ? new Set(data.usage.map((row) => row.customer)).size : 0
  const projectedTotalMinor = forecasts.reduce((sum, f) => sum + f.projectedCostMinor, 0)
  const currency = forecasts[0]?.currency ?? "USD"
  const healthy = error === null && data !== null

  return (
    <main className="shell">
      <header className="header">
        <div className="brand">
          void<span>.</span> billing
        </div>
        <div className="header-meta">
          {data?.config ? (
            <span className="mono">
              v{data.config.version} · {shortChecksum(data.config.checksum)}
            </span>
          ) : null}
          {lastUpdated ? <span>updated {lastUpdated.toLocaleTimeString()}</span> : null}
          <span className={`pill ${healthy ? "ok" : "bad"}`}>
            <span className="dot" />
            {healthy ? "live" : "unreachable"}
          </span>
        </div>
      </header>

      {error !== null && data === null ? (
        <div className="card empty">
          Can&apos;t reach the void server ({error}) — start it with{" "}
          <code>pnpm --filter @void/server dev</code>
        </div>
      ) : null}

      {data ? (
        <>
          <div className="stats">
            <div className="card">
              <div className="stat-label">Meters</div>
              <div className="stat-value">{data.config?.meters ?? 0}</div>
            </div>
            <div className="card">
              <div className="stat-label">Products</div>
              <div className="stat-value">{data.config?.products ?? 0}</div>
            </div>
            <div className="card">
              <div className="stat-label">Customers with usage</div>
              <div className="stat-value">{customers}</div>
            </div>
            <div className="card">
              <div className="stat-label">Projected metered revenue</div>
              <div className="stat-value">
                {formatMoney({ currency, amount: String(projectedTotalMinor) })}{" "}
                <small>/ {PERIOD_DAYS}d</small>
              </div>
            </div>
          </div>

          <section>
            <h2>Usage</h2>
            <UsageTable usage={data.usage} />
          </section>

          <section>
            <h2>
              Forecast
              <small>naive run rate since deploy, projected over {PERIOD_DAYS} days</small>
            </h2>
            <ForecastTable forecasts={forecasts} />
          </section>

          <section>
            <h2>
              Deployed configuration
              {data.config ? (
                <small>
                  {data.config.source ?? "unknown source"} ·{" "}
                  {new Date(data.config.deployed_at).toLocaleString()}
                </small>
              ) : null}
            </h2>
            {data.config ? (
              <ConfigPanel config={data.config} />
            ) : (
              <div className="card empty">
                No configuration deployed — run <code>void deploy billing.void</code>
              </div>
            )}
          </section>
        </>
      ) : null}
    </main>
  )
}

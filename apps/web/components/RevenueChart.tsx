"use client"

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts"
import { formatMinor } from "../lib/format"
import type { RevenuePoint } from "../lib/series"
import { Empty } from "./Empty"

const timeLabel = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

export function RevenueChart({
  currency,
  series
}: {
  readonly currency: string
  readonly series: ReadonlyArray<RevenuePoint>
}) {
  if (series.length < 2) {
    return <Empty>Earnings over time appear once a few events have been ingested</Empty>
  }
  return (
    <div className="bg-surface px-3 pb-2 pt-4">
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={[...series]} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#cfcfcf" stopOpacity={0.22} />
              <stop offset="100%" stopColor="#cfcfcf" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#1c1c1c" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={["dataMin", "dataMax"]}
            scale="time"
            tickFormatter={timeLabel}
            tick={{ fill: "#6f6f6f", fontSize: 12.5 }}
            tickLine={false}
            axisLine={{ stroke: "#212121" }}
            minTickGap={60}
          />
          <YAxis
            tickFormatter={(value: number) => formatMinor(value, currency)}
            tick={{ fill: "#6f6f6f", fontSize: 12.5 }}
            tickLine={false}
            axisLine={false}
            width={72}
          />
          <Tooltip
            cursor={{ stroke: "#2e2e2e", strokeWidth: 1 }}
            contentStyle={{
              background: "#121212",
              border: "1px solid #2e2e2e",
              borderRadius: 0,
              fontSize: 13,
              color: "#d9d9d9"
            }}
            labelFormatter={(t) => new Date(Number(t)).toLocaleTimeString()}
            formatter={(value) => [formatMinor(Number(value), currency), "earned"]}
          />
          <Area
            type="monotone"
            dataKey="accruedMinor"
            stroke="#f5f5f5"
            strokeWidth={2}
            fill="url(#revenueFill)"
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 4, fill: "#f5f5f5", stroke: "#121212", strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

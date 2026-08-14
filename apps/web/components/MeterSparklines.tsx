"use client"

import { Area, AreaChart, ResponsiveContainer, Tooltip } from "recharts"
import { formatUnits } from "../lib/format"
import type { MeterSeries } from "../lib/series"

export function MeterSparklines({ series }: { readonly series: ReadonlyArray<MeterSeries> }) {
  if (series.length === 0) return null
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
      {series.map((meter) => (
        <div className="bg-surface px-4.5 pb-2 pt-4" key={meter.meter}>
          <div className="flex items-center justify-between gap-2.5">
            <span className="font-mono text-[13px]">{meter.meter}</span>
            <span className="bg-surface-2 px-1.5 font-mono text-[12px] text-ink-muted">
              {meter.aggregation}
            </span>
          </div>
          <div className="my-1 text-2xl text-ink-strong tabular-nums">
            {formatUnits(meter.current)}
          </div>
          <ResponsiveContainer width="100%" height={56}>
            <AreaChart
              data={[...meter.points]}
              margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
            >
              <defs>
                <linearGradient id={`spark-${meter.meter}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#cfcfcf" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="#cfcfcf" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <Tooltip
                cursor={{ stroke: "#2e2e2e", strokeWidth: 1 }}
                contentStyle={{
                  background: "#121212",
                  border: "1px solid #2e2e2e",
                  borderRadius: 0,
                  fontSize: 12.5,
                  color: "#d9d9d9",
                  padding: "4px 8px"
                }}
                labelFormatter={() => ""}
                formatter={(value) => [formatUnits(Number(value)), "combined"]}
              />
              <Area
                type="monotone"
                dataKey="combined"
                stroke="#cfcfcf"
                strokeWidth={1.5}
                fill={`url(#spark-${meter.meter})`}
                isAnimationActive={false}
                dot={false}
                activeDot={{ r: 3, fill: "#f5f5f5", stroke: "#121212", strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ))}
    </div>
  )
}

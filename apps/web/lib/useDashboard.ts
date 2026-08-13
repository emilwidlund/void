"use client"

import { useEffect, useState } from "react"
import type { DashboardData } from "./types"

interface DashboardState {
  readonly data: DashboardData | null
  readonly error: string | null
  readonly lastUpdated: Date | null
}

/** Polls the void server (through the /api/void proxy) at a fixed interval. */
export function useDashboard(intervalMs = 3000): DashboardState {
  const [state, setState] = useState<DashboardState>({
    data: null,
    error: null,
    lastUpdated: null
  })

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const [usageRes, configRes] = await Promise.all([
          fetch("/api/void/v1/usage", { cache: "no-store" }),
          fetch("/api/void/v1/config", { cache: "no-store" })
        ])
        if (!usageRes.ok || !configRes.ok) {
          throw new Error(`void server responded ${usageRes.status}/${configRes.status}`)
        }
        const usage = (await usageRes.json()) as { usage: DashboardData["usage"] }
        const config = (await configRes.json()) as { active: DashboardData["config"] }
        if (!cancelled) {
          setState({
            data: { usage: usage.usage, config: config.active },
            error: null,
            lastUpdated: new Date()
          })
        }
      } catch (error) {
        if (!cancelled) {
          setState((previous) => ({
            ...previous,
            error: error instanceof Error ? error.message : String(error)
          }))
        }
      }
    }

    void load()
    const id = setInterval(() => void load(), intervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [intervalMs])

  return state
}

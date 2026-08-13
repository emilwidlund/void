"use client"

import { useEffect, useState } from "react"
import type { DashboardData } from "./types"

interface DashboardState {
  readonly data: DashboardData | null
  readonly error: string | null
  readonly lastUpdated: Date | null
}

/**
 * Subscribes to the void server's SSE stream (through the /api/void proxy).
 * Every message is a full snapshot ({ usage, config }); EventSource
 * reconnects automatically and the server replays the current snapshot on
 * connect, so missed updates self-heal.
 */
export function useDashboard(): DashboardState {
  const [state, setState] = useState<DashboardState>({
    data: null,
    error: null,
    lastUpdated: null
  })

  useEffect(() => {
    const source = new EventSource("/api/void/v1/stream")

    source.onmessage = (event: MessageEvent<string>) => {
      const snapshot = JSON.parse(event.data) as DashboardData
      setState({ data: snapshot, error: null, lastUpdated: new Date() })
    }

    source.onerror = () => {
      setState((previous) => ({
        ...previous,
        error: "stream disconnected — reconnecting"
      }))
    }

    return () => {
      source.close()
    }
  }, [])

  return state
}

import { billing } from "../billing"

/**
 * The app talks to the void *proxy*, not the parent server: entitlement and
 * enforcement checks are answered on this machine (instant, and they keep
 * working if the parent is down), while events are journaled locally and
 * forwarded upstream. Fully typed — meter/entitlement/event ids come from
 * billing.ts.
 */
export const PROXY_URL = process.env.VOID_PROXY_URL ?? "http://localhost:4010"

export const voidClient = billing.connect({ endpoint: PROXY_URL })

export const proxyHealth = async (): Promise<{
  upstream: string
  backlog: number
} | null> => {
  try {
    const response = await fetch(`${PROXY_URL}/health`, { cache: "no-store" })
    return (await response.json()) as { upstream: string; backlog: number }
  } catch {
    return null
  }
}

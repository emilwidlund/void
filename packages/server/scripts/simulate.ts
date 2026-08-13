/**
 * Sends random billing events to the void server's ingestion endpoint until
 * cancelled with Ctrl-C.
 *
 *   VOID_SERVER_URL    server base URL (default http://localhost:4000)
 *   EVENTS_PER_SECOND  send rate (default 5)
 */

export {}

const serverUrl = process.env.VOID_SERVER_URL ?? "http://localhost:4000"
const rate = Math.max(Number(process.env.EVENTS_PER_SECOND ?? 5), 0.1)

const CUSTOMERS = ["acme", "globex", "initech", "umbrella", "hooli"]
const API_PATHS = ["/v1/users", "/v1/orders", "/v1/search", "/v1/reports"]
const OTHER_EVENTS = ["user.login", "cache.miss", "webhook.delivered"]

const pick = <T>(values: ReadonlyArray<T>): T =>
  values[Math.floor(Math.random() * values.length)]!

interface SimEvent {
  readonly name: string
  readonly external_customer_id: string
  readonly properties: Record<string, string | number | boolean>
}

const randomEvent = (): SimEvent => {
  const external_customer_id = pick(CUSTOMERS)
  const roll = Math.random()
  if (roll < 0.6) {
    return {
      name: "api.request",
      external_customer_id,
      properties: {
        path: pick(API_PATHS),
        status_code: pick([200, 200, 200, 200, 201, 400, 404, 500])
      }
    }
  }
  if (roll < 0.9) {
    return {
      name: "compute.done",
      external_customer_id,
      properties: {
        status: Math.random() < 0.85 ? "success" : "failed",
        duration_s: Math.round((0.5 + Math.random() * 29.5) * 100) / 100
      }
    }
  }
  return { name: pick(OTHER_EVENTS), external_customer_id, properties: {} }
}

let sent = 0
let errors = 0
let lastError = ""
const matchedTotals: Record<string, number> = {}

const sendEvent = async (): Promise<void> => {
  try {
    const response = await fetch(`${serverUrl}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [randomEvent()] })
    })
    if (!response.ok) {
      errors += 1
      const body = await response.text()
      const message = `server responded ${response.status}: ${body}`
      if (message !== lastError) {
        lastError = message
        console.error(`\n✗ ${message}`)
        if (response.status === 409) {
          console.error(
            `  deploy a config first: void deploy examples/pro.void --endpoint ${serverUrl}/v1/deploy`
          )
        }
      }
      return
    }
    lastError = ""
    sent += 1
    const summary = (await response.json()) as { matched: Record<string, number> }
    for (const [meter, count] of Object.entries(summary.matched)) {
      matchedTotals[meter] = (matchedTotals[meter] ?? 0) + count
    }
  } catch {
    errors += 1
    const message = `void server unreachable at ${serverUrl} — is \`pnpm dev\` running?`
    if (message !== lastError) {
      lastError = message
      console.error(`\n✗ ${message}`)
    }
  }
}

const formatTotals = (): string => {
  const parts = Object.entries(matchedTotals).map(([meter, count]) => `${meter}=${count}`)
  return parts.length > 0 ? parts.join(" ") : "none yet"
}

const printStatus = () => {
  process.stdout.write(
    `\r→ ${sent} ingested · matched: ${formatTotals()}${errors > 0 ? ` · ${errors} errors` : ""}  `
  )
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

process.on("SIGINT", () => {
  printStatus()
  console.log(`\nstopped after ${sent} events`)
  process.exit(0)
})

console.log(`simulating ~${rate} events/sec against ${serverUrl} (Ctrl-C to stop)`)

const intervalMs = 1000 / rate
for (;;) {
  void sendEvent()
  printStatus()
  // jitter the interval ±30% so the stream looks organic
  await sleep(intervalMs * (0.7 + Math.random() * 0.6))
}

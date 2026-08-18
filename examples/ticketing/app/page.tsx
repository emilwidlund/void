"use client"

import { useCallback, useEffect, useState } from "react"

interface Message {
  from: "customer" | "agent"
  text: string
  tokens?: number
}

interface Ticket {
  id: string
  subject: string
  status: "open" | "solved" | "unresolved" | "reopened"
  messages: Message[]
}

interface EntitlementStatus {
  id: string
  type: "flag" | "limit" | "metered"
  limit?: number
  used?: number
  remaining?: number
  exceeded?: boolean
}

interface State {
  customer: string
  tickets: Ticket[]
  entitlements: {
    enforcement: "ok" | "blocked"
    violations: { invariant: string; behavior: string | null }[]
    entitlements: EntitlementStatus[]
  } | null
  proxy: { upstream: string; backlog: number } | null
}

const CUSTOMERS = ["acme", "globex", "initech"]

export default function Helpdesk() {
  const [customer, setCustomer] = useState("acme")
  const [state, setState] = useState<State | null>(null)
  const [subject, setSubject] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/state?customer=${customer}`, { cache: "no-store" })
    setState((await response.json()) as State)
  }, [customer])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 4000)
    return () => clearInterval(timer)
  }, [refresh])

  const act = async (input: RequestInfo, body: unknown) => {
    setBusy(true)
    setError(null)
    const response = await fetch(input, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      setError(payload.error ?? `request failed (${response.status})`)
    }
    await refresh()
    setBusy(false)
  }

  const quota = state?.entitlements?.entitlements.find((e) => e.id === "reply_quota")
  const blocked = state?.entitlements?.enforcement === "blocked"

  return (
    <main>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: "1px solid var(--line)", paddingBottom: "1rem", marginBottom: "1.5rem" }}>
        <div>
          <span style={{ fontSize: 18, color: "var(--ink-strong)" }}>helpdesk</span>
          <span style={{ color: "var(--ink-muted)", marginLeft: 10, fontSize: 13 }}>
            billed by void, through the local proxy
          </span>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 13 }}>
          <a href="http://localhost:3001" target="_blank">billing dashboard ↗</a>
          <select value={customer} onChange={(e) => setCustomer(e.target.value)}>
            {CUSTOMERS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </header>

      {blocked ? (
        <div style={{ background: "var(--surface)", borderLeft: "3px solid var(--bad)", padding: "0.8rem 1rem", marginBottom: "1.5rem", color: "var(--bad)" }}>
          This workspace is blocked — the &ldquo;runaway usage hard stop&rdquo; invariant
          tripped. New tickets are refused until the cap is raised.
        </div>
      ) : null}
      {state?.entitlements?.violations.length ? (
        <div style={{ background: "var(--surface)", padding: "0.7rem 1rem", marginBottom: "1.5rem", fontSize: 13, color: "var(--ink-muted)" }}>
          {state.entitlements.violations.map((v) => (
            <div key={v.invariant}>
              invariant <span style={{ color: "var(--bad)" }}>{v.invariant}</span> violated
              {v.behavior ? ` · remedy: ${v.behavior}` : ""}
            </div>
          ))}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 260px", gap: "1.5rem" }}>
        <section>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (subject.trim()) {
                void act("/api/tickets", { customer, subject })
                setSubject("")
              }
            }}
            style={{ display: "flex", gap: 8, marginBottom: "1.2rem" }}
          >
            <input
              style={{ flex: 1 }}
              placeholder="Describe the problem…"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
            <button disabled={busy || blocked}>Open ticket</button>
          </form>

          {error ? (
            <div style={{ color: "var(--bad)", fontSize: 13, marginBottom: "1rem" }}>✗ {error}</div>
          ) : null}

          {state?.tickets.length === 0 ? (
            <div style={{ color: "var(--ink-muted)", padding: "2rem 0" }}>
              No tickets yet — open one, let the AI agent answer it (token costs are
              reported to void), then resolve it to trigger outcome billing.
            </div>
          ) : null}

          {state?.tickets.map((ticket) => (
            <article key={ticket.id} style={{ background: "var(--surface)", padding: "1rem 1.2rem", marginBottom: "0.8rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div>
                  <span style={{ color: "var(--ink-strong)" }}>{ticket.subject}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--ink-muted)", marginLeft: 8 }}>{ticket.id}</span>
                </div>
                <span style={{ fontSize: 12, color: ticket.status === "solved" ? "var(--ok)" : ticket.status === "open" ? "var(--ink-muted)" : "var(--bad)" }}>
                  {ticket.status}
                </span>
              </div>
              {ticket.messages.map((message, index) => (
                <div key={index} style={{ marginTop: 8, fontSize: 13, color: message.from === "agent" ? "var(--ink)" : "var(--ink-muted)" }}>
                  <span style={{ fontFamily: "monospace", fontSize: 11, marginRight: 6 }}>
                    {message.from === "agent" ? "🤖" : "👤"}
                  </span>
                  {message.text}
                  {message.tokens !== undefined ? (
                    <span style={{ color: "var(--ink-muted)", fontSize: 11 }}> · {message.tokens} tokens</span>
                  ) : null}
                </div>
              ))}
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                {ticket.status === "open" || ticket.status === "reopened" ? (
                  <>
                    <button disabled={busy} onClick={() => void act(`/api/tickets/${ticket.id}`, { action: "agent" })}>
                      🤖 AI reply
                    </button>
                    <button disabled={busy} onClick={() => void act(`/api/tickets/${ticket.id}`, { action: "close", resolution: "solved" })}>
                      Resolve
                    </button>
                    <button disabled={busy} onClick={() => void act(`/api/tickets/${ticket.id}`, { action: "close", resolution: "unresolved" })}>
                      Close unresolved
                    </button>
                  </>
                ) : (
                  <button disabled={busy} onClick={() => void act(`/api/tickets/${ticket.id}`, { action: "reopen" })}>
                    Reopen
                  </button>
                )}
              </div>
            </article>
          ))}
        </section>

        <aside style={{ fontSize: 13 }}>
          <div style={{ background: "var(--surface)", padding: "1rem 1.2rem", marginBottom: "0.8rem" }}>
            <div style={{ color: "var(--ink-strong)", marginBottom: 8 }}>Billing status</div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--ink-muted)" }}>enforcement</span>
              <span style={{ color: blocked ? "var(--bad)" : "var(--ok)" }}>
                {state?.entitlements?.enforcement ?? "…"}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--ink-muted)" }}>proxy → upstream</span>
              <span style={{ color: state?.proxy?.upstream === "ok" ? "var(--ok)" : "var(--bad)" }}>
                {state?.proxy?.upstream ?? "unreachable"}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--ink-muted)" }}>event backlog</span>
              <span>{state?.proxy?.backlog ?? "–"}</span>
            </div>
          </div>

          <div style={{ background: "var(--surface)", padding: "1rem 1.2rem" }}>
            <div style={{ color: "var(--ink-strong)", marginBottom: 8 }}>Entitlements</div>
            {state?.entitlements?.entitlements.map((e) => (
              <div key={e.id} style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontFamily: "monospace", fontSize: 12 }}>{e.id}</span>
                <span style={{ color: e.exceeded ? "var(--bad)" : "var(--ink-muted)" }}>
                  {e.type === "flag"
                    ? "✓"
                    : e.type === "limit"
                      ? `≤ ${e.limit}`
                      : `${e.used}/${e.limit}`}
                </span>
              </div>
            )) ?? null}
            {quota?.exceeded ? (
              <div style={{ color: "var(--bad)", marginTop: 8 }}>
                AI reply quota exhausted — replies are refused.
              </div>
            ) : null}
          </div>
        </aside>
      </div>
    </main>
  )
}

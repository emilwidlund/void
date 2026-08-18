import { NextResponse } from "next/server"
import { getTicket } from "../../../../lib/tickets"
import { voidClient } from "../../../../lib/void"
import { usd } from "@void/sdk"

export const dynamic = "force-dynamic"

const AGENT_REPLIES = [
  "I've looked into this — the issue was a stale cache entry. Cleared it; can you retry?",
  "This is a known regression in the last deploy. I've rolled back the config for your workspace.",
  "Your API key had expired scopes. I've re-issued it with the correct permissions.",
  "The webhook endpoint was returning 410 — I've re-registered it and replayed the failed deliveries.",
]

/** Cost of one simulated model call: ~$4 per million tokens. */
const COST_PER_TOKEN = 0.000004

/**
 * Ticket actions. Every one maps to a billing event:
 *   close (solved)  -> completes the ticket_resolution outcome (+$1.50/$1)
 *   reopen          -> fails the chain, unwinding that ticket's charge
 *   agent           -> agent.reply with token count and `_cost` attached,
 *                      gated on the ai_agent flag and the reply quota
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  const { action, resolution } = (await request.json()) as {
    action: "close" | "reopen" | "agent"
    resolution?: "solved" | "unresolved"
  }
  const ticket = getTicket(id)
  if (ticket === undefined) {
    return NextResponse.json({ error: "no such ticket" }, { status: 404 })
  }
  const customer = ticket.customer

  if (action === "close") {
    ticket.status = resolution === "solved" ? "solved" : "unresolved"
    await voidClient.track("ticket.closed", {
      customer,
      properties: { ticket_id: ticket.id, resolution: ticket.status },
    })
    return NextResponse.json({ ticket })
  }

  if (action === "reopen") {
    ticket.status = "reopened"
    await voidClient.track("ticket.reopened", {
      customer,
      properties: { ticket_id: ticket.id },
    })
    return NextResponse.json({ ticket })
  }

  // action === "agent": entitlement-gated AI reply with cost reporting.
  if (!(await voidClient.allowed(customer, "ai_agent"))) {
    return NextResponse.json({ error: "AI agent not in this plan" }, { status: 402 })
  }
  if (!(await voidClient.allowed(customer, "reply_quota"))) {
    return NextResponse.json(
      { error: "monthly AI reply quota exhausted" },
      { status: 402 }
    )
  }

  const text = AGENT_REPLIES[Math.floor(Math.random() * AGENT_REPLIES.length)]!
  const tokens = 300 + Math.floor(Math.random() * 900)
  ticket.messages.push({ from: "agent", text, tokens })
  await voidClient.track("agent.reply", {
    customer,
    properties: { ticket_id: ticket.id, tokens },
    cost: usd(tokens * COST_PER_TOKEN), // billed to the customer at 70% margin
  })
  return NextResponse.json({ ticket })
}

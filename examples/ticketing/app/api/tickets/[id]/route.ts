import { voidOptions } from "@void/sdk/ai"
import { generateText } from "ai"
import { NextResponse } from "next/server"
import { getTicket } from "../../../../lib/tickets"
import { voidClient } from "../../../../void"

export const dynamic = "force-dynamic"

/**
 * Ticket actions. Every one maps to a billing event:
 *   close (solved)  -> completes the ticket_resolution outcome (+$1.50/$1)
 *   reopen          -> fails the chain, unwinding that ticket's charge
 *   agent           -> a real model call through `voidClient.ai.agent`, which
 *                      tracks `ai.agent` with token counts and `_cost` under
 *                      the hood — gated on the ai_agent flag and the quota
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

  // action === "agent": entitlement-gated AI reply.
  // One fetch answers both gates; the checks themselves are sync.
  const entitlements = await voidClient.entitlements(customer)
  if (!entitlements.allowed("ai_agent")) {
    return NextResponse.json({ error: "AI agent not in this plan" }, { status: 402 })
  }
  if (!entitlements.allowed("reply_quota")) {
    return NextResponse.json(
      { error: "monthly AI reply quota exhausted" },
      { status: 402 }
    )
  }

  // The model is already wrapped by the config's `agent` meter: this call
  // tracks `ai.agent` with token counts and its `_cost` — no manual event.
  const lastFromCustomer = [...ticket.messages]
    .reverse()
    .find((message) => message.from === "customer")
  const { text, usage } = await generateText({
    model: voidClient.ai.agent,
    system:
      "You are a support agent for a developer tool. Reply concisely with a concrete fix.",
    prompt: `Ticket: ${ticket.subject}${
      lastFromCustomer !== undefined ? `\nCustomer: ${lastFromCustomer.text}` : ""
    }`,
    providerOptions: {
      void: voidOptions({ customer, properties: { ticket_id: ticket.id } }),
    },
  })
  ticket.messages.push({ from: "agent", text, tokens: usage.totalTokens })
  return NextResponse.json({ ticket })
}

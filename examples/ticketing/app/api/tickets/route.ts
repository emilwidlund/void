import { NextResponse } from "next/server"
import { createTicket } from "../../../lib/tickets"
import { voidClient } from "../../../void"

export const dynamic = "force-dynamic"

/** Open a ticket: gated on enforcement, tracked as the outcome chain's first step. */
export async function POST(request: Request) {
  const { customer, subject } = (await request.json()) as {
    customer: string
    subject: string
  }
  if (!subject?.trim()) {
    return NextResponse.json({ error: "subject required" }, { status: 400 })
  }

  // A violated `spend(customer) <= ... else block` invariant flips
  // enforcement on the proxy — the app is expected to stop serving.
  const status = await voidClient.entitlements(customer).catch(() => null)
  if (status?.enforcement === "blocked") {
    return NextResponse.json(
      { error: "workspace blocked: spend cap exceeded" },
      { status: 402 }
    )
  }

  const ticket = createTicket(customer, subject.trim())
  await voidClient.track("ticket.opened", {
    customer,
    properties: { ticket_id: ticket.id },
  })
  return NextResponse.json({ ticket })
}

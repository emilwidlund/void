import { NextResponse } from "next/server"
import { listTickets } from "../../../lib/tickets"
import { proxyHealth, voidClient } from "../../../lib/void"

export const dynamic = "force-dynamic"

/** Everything the UI needs: tickets + live billing state from the proxy. */
export async function GET(request: Request) {
  const customer = new URL(request.url).searchParams.get("customer") ?? "acme"
  const [entitlements, health] = await Promise.all([
    voidClient.entitlements(customer).catch(() => null),
    proxyHealth(),
  ])
  return NextResponse.json({
    customer,
    tickets: listTickets(customer),
    entitlements,
    proxy: health,
  })
}

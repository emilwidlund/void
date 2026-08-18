/**
 * In-memory ticket store — this demo is about the billing integration, not
 * the database. Survives hot reloads via globalThis; resets on restart
 * (billing state doesn't: the proxy's journal is durable).
 */

export interface Message {
  readonly from: "customer" | "agent"
  readonly text: string
  readonly tokens?: number
}

export interface Ticket {
  readonly id: string
  readonly customer: string
  readonly subject: string
  status: "open" | "solved" | "unresolved" | "reopened"
  readonly messages: Message[]
  readonly createdAt: string
}

interface Store {
  readonly tickets: Map<string, Ticket>
  seq: number
}

const globalStore = globalThis as unknown as { __ticketStore?: Store }
const store: Store =
  globalStore.__ticketStore ?? (globalStore.__ticketStore = { tickets: new Map(), seq: 0 })

export const listTickets = (customer: string): Ticket[] =>
  [...store.tickets.values()]
    .filter((ticket) => ticket.customer === customer)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

export const getTicket = (id: string): Ticket | undefined => store.tickets.get(id)

export const createTicket = (customer: string, subject: string): Ticket => {
  store.seq += 1
  const ticket: Ticket = {
    id: `${customer}-${store.seq}`,
    customer,
    subject,
    status: "open",
    messages: [{ from: "customer", text: subject }],
    createdAt: new Date().toISOString(),
  }
  store.tickets.set(ticket.id, ticket)
  return ticket
}

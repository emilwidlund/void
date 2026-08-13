import type { NextRequest } from "next/server"

// Runtime proxy to the void server. A route handler (rather than a rewrite)
// so VOID_SERVER_URL is read at request time, not baked in at build time.

export const dynamic = "force-dynamic"

const serverUrl = () => process.env.VOID_SERVER_URL ?? "http://localhost:4000"

const proxy = async (
  request: NextRequest,
  context: { params: Promise<{ path: ReadonlyArray<string> }> }
) => {
  const { path } = await context.params
  const target = `${serverUrl()}/${path.join("/")}`
  try {
    const response = await fetch(target, {
      method: request.method,
      headers: {
        "content-type": request.headers.get("content-type") ?? "application/json"
      },
      body: request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.text(),
      cache: "no-store"
    })
    // Pass the body through as a stream so SSE responses flow to the browser
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": response.headers.get("cache-control") ?? "no-store"
      }
    })
  } catch {
    return new Response(
      JSON.stringify({ error: `void server unreachable at ${serverUrl()}` }),
      { status: 502, headers: { "content-type": "application/json" } }
    )
  }
}

export { proxy as GET, proxy as POST }

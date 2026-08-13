import { NodeContext, NodeHttpClient } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Console, Effect } from "effect"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { cli } from "../src/Cli.js"

const fixture = (name: string) =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name)

interface ReceivedRequest {
  readonly method: string
  readonly url: string
  readonly authorization: string | undefined
  readonly body: string
}

interface TestServer {
  readonly url: string
  readonly requests: Array<ReceivedRequest>
}

/** Starts a local HTTP server; requests to /fail get a 500, everything else a 200. */
const withServer = <A, E, R>(use: (server: TestServer) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.async<{ close: () => void } & TestServer>((resume) => {
      const requests: Array<ReceivedRequest> = []
      const server = createServer((req, res) => {
        let body = ""
        req.on("data", (chunk) => {
          body += chunk
        })
        req.on("end", () => {
          requests.push({
            method: req.method ?? "",
            url: req.url ?? "",
            authorization: req.headers.authorization,
            body
          })
          const status = req.url === "/fail" ? 500 : 200
          res.writeHead(status, { "content-type": "application/json" })
          res.end(status === 200 ? '{"status":"accepted"}' : '{"error":"boom"}')
        })
      })
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}`,
            requests,
            close: () => server.close()
          })
        )
      })
    }),
    use,
    (server) => Effect.sync(server.close)
  )

const runCli = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const logs: Array<string> = []
    const errors: Array<string> = []
    const base = yield* Effect.console
    const capture = (sink: Array<string>) => (...values: ReadonlyArray<unknown>) =>
      Effect.sync(() => {
        sink.push(values.map(String).join(" "))
      })
    const testConsole: Console.Console = {
      ...base,
      log: capture(logs),
      error: capture(errors)
    }
    yield* cli(["node", "void", ...args]).pipe(Console.withConsole(testConsole))
    return { logs, errors }
  })

const layers = [NodeContext.layer, NodeHttpClient.layer] as const

it.effect("`void deploy` POSTs the checksummed payload with a bearer token", () =>
  withServer((server) =>
    Effect.gen(function* () {
      const { errors, logs } = yield* runCli([
        "deploy",
        fixture("pro.void"),
        "--endpoint",
        `${server.url}/deploy`,
        "--token",
        "secret-token"
      ])
      expect(errors).toEqual([])
      expect(logs.some((l) => l.includes("✓ deployed sha256:"))).toBe(true)

      expect(server.requests).toHaveLength(1)
      const request = server.requests[0]!
      expect(request.method).toBe("POST")
      expect(request.url).toBe("/deploy")
      expect(request.authorization).toBe("Bearer secret-token")

      const payload = JSON.parse(request.body)
      expect(payload.checksum).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(payload.ir.version).toBe(1)
      expect(payload.ir.meters[0].id).toBe("api_calls")
      expect(payload.meta.source).toContain("pro.void")
    })
  ).pipe(Effect.provide(layers))
)

it.effect("`void deploy --dry-run` prints the payload without sending", () =>
  withServer((server) =>
    Effect.gen(function* () {
      const { errors, logs } = yield* runCli([
        "deploy",
        fixture("pro.void"),
        "--endpoint",
        `${server.url}/deploy`,
        "--dry-run"
      ])
      expect(errors).toEqual([])
      expect(logs[0]).toContain("would deploy sha256:")
      expect(logs[0]).toContain("(dry run)")
      expect(server.requests).toHaveLength(0)
      const payload = JSON.parse(logs.slice(1).join("\n"))
      expect(payload.ir.products[0].id).toBe("pro")
    })
  ).pipe(Effect.provide(layers))
)

it.effect("`void deploy` produces a stable checksum across runs", () =>
  withServer((server) =>
    Effect.gen(function* () {
      const args = ["deploy", fixture("pro.void"), "--endpoint", server.url, "--dry-run"]
      const first = yield* runCli(args)
      const second = yield* runCli(args)
      expect(first.logs[0]).toBe(second.logs[0])
    })
  ).pipe(Effect.provide(layers))
)

it.effect("`void deploy` fails with exit code 1 on a server error", () =>
  withServer((server) =>
    Effect.gen(function* () {
      const { errors } = yield* runCli([
        "deploy",
        fixture("pro.void"),
        "--endpoint",
        `${server.url}/fail`
      ])
      expect(errors.some((l) => l.includes("✗ server responded 500"))).toBe(true)
      expect(process.exitCode).toBe(1)
      process.exitCode = 0
    })
  ).pipe(Effect.provide(layers))
)

it.effect("`void deploy` does not send anything when compilation fails", () =>
  withServer((server) =>
    Effect.gen(function* () {
      const { errors } = yield* runCli([
        "deploy",
        fixture("bad.void"),
        "--endpoint",
        server.url
      ])
      expect(errors.join("\n")).toContain("error[VOID101]")
      expect(server.requests).toHaveLength(0)
      expect(process.exitCode).toBe(1)
      process.exitCode = 0
    })
  ).pipe(Effect.provide(layers))
)

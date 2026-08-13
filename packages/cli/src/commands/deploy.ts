import { Args, Command, Options } from "@effect/cli"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import type { BillingIr } from "@void/compiler"
import { Config, Console, Effect, Either, Option } from "effect"
import { createHash } from "node:crypto"
import { compileFile, reportFailure, reportWarnings } from "./shared.js"

export interface DeployPayload {
  /** sha256 over the canonical (compact) IR JSON — formatting/comment changes don't alter it. */
  readonly checksum: string
  readonly ir: BillingIr
  readonly meta: {
    readonly source: string
    readonly compiler: string
  }
}

export const checksumIr = (ir: BillingIr): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(ir)).digest("hex")}`

const file = Args.file({ name: "file", exists: "yes" })

const endpoint = Options.text("endpoint").pipe(
  Options.withDescription("Void server URL to deploy to"),
  Options.withFallbackConfig(Config.string("VOID_ENDPOINT"))
)

const token = Options.text("token").pipe(
  Options.withDescription("Bearer token for authentication"),
  Options.withFallbackConfig(Config.string("VOID_TOKEN")),
  Options.optional
)

const dryRun = Options.boolean("dry-run").pipe(
  Options.withDescription("Compile and print the deploy payload without sending it")
)

export const deployCommand = Command.make(
  "deploy",
  { file, endpoint, token, dryRun },
  ({ dryRun, endpoint, file, token }) =>
    Effect.gen(function* () {
      const { outcome, source } = yield* compileFile(file)
      if (Either.isLeft(outcome)) {
        return yield* reportFailure(outcome.left)
      }
      yield* reportWarnings(outcome.right, source, file)

      const ir = outcome.right.ir
      const payload: DeployPayload = {
        checksum: checksumIr(ir),
        ir,
        meta: { source: file, compiler: "0.0.1" }
      }

      if (dryRun) {
        yield* Console.log(`would deploy ${payload.checksum} to ${endpoint} (dry run)`)
        yield* Console.log(JSON.stringify(payload, null, 2))
        return
      }

      const request = HttpClientRequest.post(endpoint).pipe(
        Option.match(token, {
          onNone: () => (r: HttpClientRequest.HttpClientRequest) => r,
          onSome: (t) => HttpClientRequest.bearerToken(t)
        }),
        HttpClientRequest.bodyUnsafeJson(payload)
      )

      const client = yield* HttpClient.HttpClient
      const result = yield* client.execute(request).pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (body) => ({ status: response.status, body }))
        ),
        Effect.scoped,
        Effect.either
      )

      if (Either.isLeft(result)) {
        yield* Console.error(`✗ deploy failed: ${result.left.message}`)
        return yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }

      const { body, status } = result.right
      if (status >= 200 && status < 300) {
        yield* Console.log(`✓ deployed ${payload.checksum} to ${endpoint} (${status})`)
        if (body.length > 0) yield* Console.log(body)
      } else {
        yield* Console.error(`✗ server responded ${status}`)
        if (body.length > 0) yield* Console.error(body)
        yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }
    })
).pipe(
  Command.withDescription(
    "Compile a billing configuration and deploy its checksummed IR to a void server"
  )
)

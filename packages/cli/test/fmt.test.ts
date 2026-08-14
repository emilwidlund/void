import { NodeContext, NodeHttpClient } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Console, Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { cli } from "../src/Cli.js"

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

const messy = `meter  api_calls {
    filter event.name  == "api.request"
  aggregate count }
`

const formatted = `meter api_calls {
  filter event.name == "api.request"
  aggregate count
}
`

it.effect("`void fmt` rewrites the file canonically and is then a no-op", () =>
  Effect.gen(function* () {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "void-fmt-")), "m.void")
    fs.writeFileSync(file, messy)

    const first = yield* runCli(["fmt", file])
    expect(first.errors).toEqual([])
    expect(first.logs[0]).toContain("formatted")
    expect(fs.readFileSync(file, "utf8")).toBe(formatted)

    const second = yield* runCli(["fmt", file])
    expect(second.logs[0]).toContain("already formatted")
  }).pipe(Effect.provide(layers))
)

it.effect("`void fmt --check` fails on unformatted input without writing", () =>
  Effect.gen(function* () {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "void-fmt-")), "m.void")
    fs.writeFileSync(file, messy)

    const { errors } = yield* runCli(["fmt", "--check", file])
    expect(errors[0]).toContain("not formatted")
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
    expect(fs.readFileSync(file, "utf8")).toBe(messy)
  }).pipe(Effect.provide(layers))
)

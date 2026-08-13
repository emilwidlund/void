import { NodeContext, NodeHttpClient } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Console, Effect } from "effect"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { cli } from "../src/Cli.js"

const fixture = (name: string) =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name)

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

it.effect("`void check` reports success for a valid config", () =>
  Effect.gen(function* () {
    const { errors, logs } = yield* runCli(["check", fixture("pro.void")])
    expect(errors).toEqual([])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("✓")
    expect(logs[0]).toContain("1 meter, 1 product")
  }).pipe(Effect.provide([NodeContext.layer, NodeHttpClient.layer]))
)

it.effect("`void check` renders diagnostics and sets a failing exit code", () =>
  Effect.gen(function* () {
    const { errors, logs } = yield* runCli(["check", fixture("bad.void")])
    expect(logs).toEqual([])
    const output = errors.join("\n")
    expect(output).toContain("error[VOID101]: unknown meter `nope`")
    expect(output).toContain("error[VOID104]: product `pro` is missing a `name`")
    expect(output).toContain("2 errors")
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  }).pipe(Effect.provide([NodeContext.layer, NodeHttpClient.layer]))
)

it.effect("`void build` prints the JSON IR", () =>
  Effect.gen(function* () {
    const { errors, logs } = yield* runCli(["build", fixture("pro.void")])
    expect(errors).toEqual([])
    const ir = JSON.parse(logs.join("\n"))
    expect(ir.version).toBe(1)
    expect(ir.meters.map((m: { id: string }) => m.id)).toEqual(["api_calls"])
    expect(ir.products[0]).toMatchObject({
      id: "pro",
      name: "Pro Plan",
      prices: [
        { type: "recurring", interval: "month", amount: { currency: "USD", amount: "2900" } },
        {
          type: "metered",
          meter: "api_calls",
          per_unit: { currency: "USD", amount: "10" },
          included_units: 10000
        }
      ]
    })
  }).pipe(Effect.provide([NodeContext.layer, NodeHttpClient.layer]))
)

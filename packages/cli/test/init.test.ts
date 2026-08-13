import { NodeContext } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Console, Effect } from "effect"
import { cli } from "../src/Cli.js"

it.effect("`void init` prints hello world", () =>
  Effect.gen(function* () {
    const lines: Array<string> = []
    const base = yield* Effect.console
    const testConsole: Console.Console = {
      ...base,
      log: (...args: ReadonlyArray<unknown>) =>
        Effect.sync(() => {
          lines.push(args.map(String).join(" "))
        })
    }
    yield* cli(["node", "void", "init"]).pipe(Console.withConsole(testConsole))
    expect(lines).toContain("hello world")
  }).pipe(Effect.provide(NodeContext.layer))
)

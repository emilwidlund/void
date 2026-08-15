import { Args, Command } from "@effect/cli"
import { Console, Effect, Either } from "effect"
import { compileFile, reportFailure, reportWarnings } from "./shared.js"

const file = Args.file({ name: "file", exists: "yes" })

export const checkCommand = Command.make("check", { file }, ({ file }) =>
  Effect.gen(function* () {
    const { outcome, source } = yield* compileFile(file)
    if (Either.isLeft(outcome)) {
      return yield* reportFailure(outcome.left)
    }
    const result = outcome.right
    yield* reportWarnings(result, source, file)
    const meters = result.ir.meters.length
    const outcomes = result.ir.outcomes.length
    const products = result.ir.products.length
    const warnings = result.diagnostics.length
    yield* Console.log(
      `✓ ${file} — ${meters} meter${meters === 1 ? "" : "s"}, ` +
        (outcomes > 0 ? `${outcomes} outcome${outcomes === 1 ? "" : "s"}, ` : "") +
        `${products} product${products === 1 ? "" : "s"}` +
        (warnings > 0 ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : "")
    )
  })
).pipe(Command.withDescription("Type-check a billing configuration without emitting output"))

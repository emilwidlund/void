import { Args, Command } from "@effect/cli"
import { Console, Effect, Either } from "effect"
import { compileFile, reportFailure, reportWarnings } from "./shared.js"

const file = Args.file({ name: "file", exists: "yes" })

export const buildCommand = Command.make("build", { file }, ({ file }) =>
  Effect.gen(function* () {
    const { outcome, source } = yield* compileFile(file)
    if (Either.isLeft(outcome)) {
      return yield* reportFailure(outcome.left)
    }
    yield* reportWarnings(outcome.right, source, file)
    yield* Console.log(JSON.stringify(outcome.right.ir, null, 2))
  })
).pipe(Command.withDescription("Compile a billing configuration to JSON IR on stdout"))

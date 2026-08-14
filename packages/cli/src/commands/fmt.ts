import { Args, Command, Options } from "@effect/cli"
import { FileSystem } from "@effect/platform"
import { formatSource, hasErrors, parse, renderDiagnostics, tokenize } from "@void/compiler"
import { Console, Effect } from "effect"

const file = Args.file({ name: "file", exists: "yes" })

const check = Options.boolean("check").pipe(
  Options.withDescription("Exit non-zero if the file is not canonically formatted (for CI)")
)

const fail = (message: string) =>
  Effect.gen(function* () {
    yield* Console.error(message)
    yield* Effect.sync(() => {
      process.exitCode = 1
    })
  })

export const fmtCommand = Command.make("fmt", { file, check }, ({ check, file }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const source = yield* fs.readFileString(file)

    // Formatting only needs a parse — semantic (checker) errors don't block it.
    const lexed = tokenize(source)
    if (hasErrors(lexed.diagnostics)) {
      return yield* fail(renderDiagnostics(lexed.diagnostics, source, file))
    }
    const parsed = parse(lexed.tokens)
    if (hasErrors(parsed.diagnostics)) {
      return yield* fail(renderDiagnostics(parsed.diagnostics, source, file))
    }

    const formatted = formatSource(parsed.file, lexed.comments)
    if (formatted === source) {
      yield* Console.log(`✓ ${file} already formatted`)
      return
    }
    if (check) {
      return yield* fail(`✗ ${file} is not formatted (run \`void fmt ${file}\`)`)
    }
    yield* fs.writeFileString(file, formatted)
    yield* Console.log(`✓ formatted ${file}`)
  })
).pipe(Command.withDescription("Canonically format a billing configuration in place"))

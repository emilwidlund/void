import { FileSystem } from "@effect/platform"
import type { CompileError, CompileResult } from "@void/compiler"
import { compile, renderDiagnostics } from "@void/compiler"
import { Console, Effect } from "effect"

/** Reads and compiles a .void file, returning the outcome without failing the effect. */
export const compileFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const source = yield* fs.readFileString(path)
    const outcome = yield* Effect.either(compile(source, { fileName: path }))
    return { source, outcome }
  })

export const reportFailure = (failure: CompileError) =>
  Effect.gen(function* () {
    yield* Console.error(renderDiagnostics(failure.diagnostics, failure.source, failure.fileName))
    const errors = failure.diagnostics.filter((d) => d.severity === "error").length
    yield* Console.error(`\n✗ ${failure.fileName}: ${errors} error${errors === 1 ? "" : "s"}`)
    yield* Effect.sync(() => {
      process.exitCode = 1
    })
  })

export const reportWarnings = (result: CompileResult, source: string, fileName: string) =>
  result.diagnostics.length > 0
    ? Console.error(renderDiagnostics(result.diagnostics, source, fileName))
    : Effect.void

import { Data, Effect } from "effect"
import { check } from "./Checker.js"
import type { Diagnostic } from "./Diagnostic.js"
import { hasErrors } from "./Diagnostic.js"
import { emit } from "./Ir.js"
import type { BillingIr } from "./Ir.js"
import { tokenize } from "./Lexer.js"
import { parse } from "./Parser.js"

export * from "./Ast.js"
export * from "./Checker.js"
export * from "./Diagnostic.js"
export * from "./Ir.js"
export * from "./Lexer.js"
export * from "./Parser.js"

export class CompileError extends Data.TaggedError("CompileError")<{
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly source: string
  readonly fileName: string
}> {
  override get message(): string {
    const errors = this.diagnostics.filter((d) => d.severity === "error").length
    return `${this.fileName}: ${errors} error${errors === 1 ? "" : "s"}`
  }
}

export interface CompileResult {
  readonly ir: BillingIr
  /** Warnings produced while compiling (never contains errors). */
  readonly diagnostics: ReadonlyArray<Diagnostic>
}

export interface CompileOptions {
  readonly fileName?: string
}

export const compile = (
  source: string,
  options?: CompileOptions
): Effect.Effect<CompileResult, CompileError> =>
  Effect.suspend(() => {
    const fileName = options?.fileName ?? "<input>"
    const fail = (diagnostics: ReadonlyArray<Diagnostic>) =>
      Effect.fail(new CompileError({ diagnostics, source, fileName }))

    const lexed = tokenize(source)
    if (hasErrors(lexed.diagnostics)) return fail(lexed.diagnostics)

    const parsed = parse(lexed.tokens)
    if (hasErrors(parsed.diagnostics)) return fail(parsed.diagnostics)

    const diagnostics = [...lexed.diagnostics, ...parsed.diagnostics, ...check(parsed.file)]
    if (hasErrors(diagnostics)) return fail(diagnostics)

    return Effect.succeed({ ir: emit(parsed.file), diagnostics })
  })

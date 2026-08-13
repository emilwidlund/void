export interface Position {
  /** 1-based */
  readonly line: number
  /** 1-based */
  readonly column: number
  readonly offset: number
}

export interface Span {
  readonly start: Position
  readonly end: Position
}

export type Severity = "error" | "warning"

export interface Diagnostic {
  readonly severity: Severity
  readonly code: string
  readonly message: string
  readonly span: Span
}

export const error = (code: string, message: string, span: Span): Diagnostic => ({
  severity: "error",
  code,
  message,
  span
})

export const warning = (code: string, message: string, span: Span): Diagnostic => ({
  severity: "warning",
  code,
  message,
  span
})

export const hasErrors = (diagnostics: ReadonlyArray<Diagnostic>): boolean =>
  diagnostics.some((d) => d.severity === "error")

/**
 * Renders a diagnostic in a rustc-like format:
 *
 * ```
 * error[VOID101]: unknown meter "api_call"
 *   --> billing.void:12:17
 *    |
 * 12 |   price metered api_call {
 *    |                 ^^^^^^^^
 * ```
 */
export const renderDiagnostic = (
  diagnostic: Diagnostic,
  source: string,
  fileName: string
): string => {
  const { code, message, severity, span } = diagnostic
  const lines = source.split(/\r?\n/)
  const lineText = lines[span.start.line - 1] ?? ""
  const lineNo = String(span.start.line)
  const gutter = " ".repeat(lineNo.length)
  const underlineLength =
    span.end.line === span.start.line
      ? Math.max(1, span.end.column - span.start.column)
      : Math.max(1, lineText.length - span.start.column + 1)
  const underline = " ".repeat(span.start.column - 1) + "^".repeat(underlineLength)
  return [
    `${severity}[${code}]: ${message}`,
    `${gutter}--> ${fileName}:${span.start.line}:${span.start.column}`,
    `${gutter} |`,
    `${lineNo} | ${lineText}`,
    `${gutter} | ${underline}`
  ].join("\n")
}

export const renderDiagnostics = (
  diagnostics: ReadonlyArray<Diagnostic>,
  source: string,
  fileName: string
): string => diagnostics.map((d) => renderDiagnostic(d, source, fileName)).join("\n\n")

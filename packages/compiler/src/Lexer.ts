import type { Diagnostic, Position, Span } from "./Diagnostic.js"
import * as D from "./Diagnostic.js"

export type TokenKind =
  | "Ident"
  | "String"
  | "Number"
  | "LBrace"
  | "RBrace"
  | "LParen"
  | "RParen"
  | "Dot"
  | "Comma"
  | "Percent"
  | "Op"
  | "EOF"

export interface Token {
  readonly kind: TokenKind
  /** The raw source text of the token. */
  readonly text: string
  /** Unescaped string contents / normalized number (underscores stripped). */
  readonly value: string
  readonly span: Span
}

/** A `# ...` comment, captured as trivia so the formatter can preserve it. */
export interface Comment {
  /** full comment text including the leading `#` */
  readonly text: string
  readonly span: Span
}

export interface LexResult {
  readonly tokens: ReadonlyArray<Token>
  readonly comments: ReadonlyArray<Comment>
  readonly diagnostics: ReadonlyArray<Diagnostic>
}

const isIdentStart = (ch: string) => /[A-Za-z_]/.test(ch)
const isIdentPart = (ch: string) => /[A-Za-z0-9_]/.test(ch)
const isDigit = (ch: string) => ch >= "0" && ch <= "9"

export const tokenize = (source: string): LexResult => {
  const tokens: Array<Token> = []
  const comments: Array<Comment> = []
  const diagnostics: Array<Diagnostic> = []

  let offset = 0
  let line = 1
  let column = 1

  const position = (): Position => ({ line, column, offset })
  const peek = (ahead = 0): string => source[offset + ahead] ?? ""
  const advance = (): string => {
    const ch = source[offset] ?? ""
    offset += 1
    if (ch === "\n") {
      line += 1
      column = 1
    } else {
      column += 1
    }
    return ch
  }

  const push = (kind: TokenKind, start: Position, value?: string) => {
    const text = source.slice(start.offset, offset)
    tokens.push({ kind, text, value: value ?? text, span: { start, end: position() } })
  }

  while (offset < source.length) {
    const ch = peek()

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      advance()
      continue
    }

    if (ch === "#") {
      const commentStart = position()
      while (offset < source.length && peek() !== "\n") advance()
      comments.push({
        text: source.slice(commentStart.offset, offset).trimEnd(),
        span: { start: commentStart, end: position() }
      })
      continue
    }

    const start = position()

    if (isDigit(ch)) {
      while (isDigit(peek()) || peek() === "_") advance()
      if (peek() === "." && isDigit(peek(1))) {
        advance()
        while (isDigit(peek()) || peek() === "_") advance()
      }
      const raw = source.slice(start.offset, offset)
      push("Number", start, raw.replace(/_/g, ""))
      continue
    }

    if (isIdentStart(ch)) {
      while (isIdentPart(peek())) advance()
      push("Ident", start)
      continue
    }

    if (ch === '"') {
      advance()
      let value = ""
      let terminated = false
      while (offset < source.length) {
        const c = advance()
        if (c === '"') {
          terminated = true
          break
        }
        if (c === "\n") break
        if (c === "\\") {
          const esc = advance()
          value += esc === "n" ? "\n" : esc === "t" ? "\t" : esc
        } else {
          value += c
        }
      }
      if (!terminated) {
        diagnostics.push(
          D.error("VOID002", "unterminated string literal", { start, end: position() })
        )
      }
      push("String", start, value)
      continue
    }

    const twoChar = source.slice(offset, offset + 2)
    if (twoChar === "==" || twoChar === "!=" || twoChar === ">=" || twoChar === "<=") {
      advance()
      advance()
      push("Op", start)
      continue
    }
    if (ch === ">" || ch === "<") {
      advance()
      push("Op", start)
      continue
    }

    const single: Partial<Record<string, TokenKind>> = {
      "{": "LBrace",
      "}": "RBrace",
      "(": "LParen",
      ")": "RParen",
      ".": "Dot",
      ",": "Comma",
      "%": "Percent"
    }
    const kind = single[ch]
    if (kind !== undefined) {
      advance()
      push(kind, start)
      continue
    }

    advance()
    diagnostics.push(
      D.error("VOID001", `unexpected character ${JSON.stringify(ch)}`, {
        start,
        end: position()
      })
    )
  }

  const eofPosition = position()
  tokens.push({ kind: "EOF", text: "", value: "", span: { start: eofPosition, end: eofPosition } })

  return { tokens, comments, diagnostics }
}

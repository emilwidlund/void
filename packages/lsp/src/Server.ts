import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind
} from "vscode-languageserver/node.js"
import { TextDocument } from "vscode-languageserver-textdocument"
import { completionsAt, computeDiagnostics, definitionAt, hoverAt } from "./Core.js"

/**
 * The void language server: diagnostics on every edit, keyword/meter
 * completion, go-to-definition and hover for meter references. Transport
 * (stdio or node-ipc) is auto-detected from argv by `createConnection`.
 */
export const startServer = (): void => {
  const connection = createConnection(ProposedFeatures.all)
  const documents = new TextDocuments(TextDocument)

  connection.onInitialize(() => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Space and `(` trigger value-position completions (`unit `, `else `,
      // `spend(`); non-value positions return [] so this stays quiet.
      completionProvider: { triggerCharacters: [" ", "("] },
      definitionProvider: true,
      hoverProvider: true
    }
  }))

  documents.onDidChangeContent((change) => {
    void connection.sendDiagnostics({
      uri: change.document.uri,
      diagnostics: computeDiagnostics(change.document.getText()).map((d) => ({
        range: d.range,
        severity: d.severity,
        code: d.code,
        message: d.message,
        source: d.source
      }))
    })
  })

  connection.onCompletion((params) => {
    const document = documents.get(params.textDocument.uri)
    if (document === undefined) return []
    const offset = document.offsetAt(params.position)
    return completionsAt(document.getText(), offset).map((item) => ({
      label: item.label,
      kind: item.kind,
      ...(item.detail !== undefined ? { detail: item.detail } : {})
    }))
  })

  connection.onDefinition((params) => {
    const document = documents.get(params.textDocument.uri)
    if (document === undefined) return null
    const range = definitionAt(document.getText(), document.offsetAt(params.position))
    return range === null ? null : { uri: params.textDocument.uri, range }
  })

  connection.onHover((params) => {
    const document = documents.get(params.textDocument.uri)
    if (document === undefined) return null
    const contents = hoverAt(document.getText(), document.offsetAt(params.position))
    return contents === null
      ? null
      : { contents: { kind: "markdown" as const, value: contents } }
  })

  documents.listen(connection)
  connection.listen()
}

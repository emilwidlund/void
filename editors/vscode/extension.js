// VS Code client for the void language server (@void/lsp).
const fs = require("node:fs")
const path = require("node:path")
const { workspace } = require("vscode")
const { LanguageClient, TransportKind } = require("vscode-languageclient/node")

let client

const findServer = () => {
  const configured = workspace.getConfiguration("void").get("serverPath")
  if (configured) return { module: configured }
  for (const folder of workspace.workspaceFolders ?? []) {
    for (const candidate of [
      path.join(folder.uri.fsPath, "packages/lsp/dist/bin.js"),
      path.join(folder.uri.fsPath, "node_modules/@void/lsp/dist/bin.js")
    ]) {
      if (fs.existsSync(candidate)) return { module: candidate }
    }
  }
  return { command: "void-lsp" }
}

exports.activate = () => {
  const server = findServer()
  const serverOptions = server.module
    ? {
        run: { module: server.module, transport: TransportKind.ipc },
        debug: { module: server.module, transport: TransportKind.ipc }
      }
    : {
        run: { command: server.command, args: ["--stdio"] },
        debug: { command: server.command, args: ["--stdio"] }
      }

  client = new LanguageClient(
    "void",
    "void billing",
    serverOptions,
    { documentSelector: [{ language: "void" }] }
  )
  client.start()
}

exports.deactivate = () => (client ? client.stop() : undefined)

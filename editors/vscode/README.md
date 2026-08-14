# void billing DSL — VS Code extension

Language support for `.void` files: syntax highlighting, live diagnostics,
completion, go-to-definition and hover, backed by the `@void/lsp` language
server.

## Install (local)

Build the workspace so the language server exists, then symlink the extension
and reload VS Code:

```sh
pnpm install && pnpm build
ln -s "$(pwd)/editors/vscode" ~/.vscode/extensions/void-billing-0.0.1
```

Or package it properly with [vsce](https://github.com/microsoft/vscode-vsce):

```sh
cd editors/vscode && npx @vscode/vsce package
code --install-extension void-billing-0.0.1.vsix
```

## Install (Cursor)

Cursor is a VS Code fork, so the same extension works — only the extensions
directory differs:

```sh
pnpm install && pnpm build
ln -s "$(pwd)/editors/vscode" ~/.cursor/extensions/void-billing-0.0.1
```

Fully restart Cursor (Cmd+Q) and open a `.void` file. A packaged VSIX also
installs via `cursor --install-extension void-billing-0.0.1.vsix` or the
Extensions panel's *Install from VSIX*.

## Server discovery

The client finds the server automatically (workspace
`packages/lsp/dist/bin.js`, then `node_modules/@void/lsp/dist/bin.js`, then
`void-lsp` on PATH); override with the `void.serverPath` setting. When
editing `.void` files in a project other than this repo, either set
`void.serverPath` to an absolute path to `packages/lsp/dist/bin.js`, or link
the server onto your PATH: `pnpm --filter @void/lsp exec pnpm link --global`.

## Features

- **Diagnostics as you type** — the compiler's full lex/parse/check pipeline
  runs on every edit, so `error[VOID120]`-style findings appear as squiggles
  with their exact spans.
- **Completion** — context-aware keywords per block (meter fields, pricing
  fields, entitlement fields, invariant metrics and behaviors) plus declared
  meter names, even while the file is mid-edit and unparseable.
- **Go-to-definition** — jump from any meter reference (product binding,
  entitlement, invariant) to the top-level declaration.
- **Hover** — meter references show the declaration's aggregation, unit and
  filter.
- **Highlighting** — declarations, field keywords, money literals
  (`29 USD`, `10 USD_CENTS`), percentages, `event.*` paths, operators and
  `else cap`-style behaviors, plus `#` comment toggling and bracket pairs.

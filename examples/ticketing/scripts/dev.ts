/**
 * One-command demo: `pnpm --filter void-ticketing-demo dev`
 *
 * Boots the whole void stack so the proxy always has a live target:
 *
 *   1. parent void server   :4000  (the "hosted" billing backend)
 *   2. billing dashboard    :3001  (@void/web, pointed at the parent)
 *   3. deploys billing.ts to the parent (checksum-idempotent)
 *   4. void proxy           :4010  (merchant sidecar, journal in .void-proxy/)
 *   5. this ticketing app   :3005
 *
 * Ctrl-C tears everything down.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { billing } from "../billing.js"

const here = fileURLToPath(new URL(".", import.meta.url))
const repoRoot = join(here, "..", "..", "..")
const PARENT = "http://127.0.0.1:4000"
const PROXY = "http://127.0.0.1:4010"

const log = (message: string) => console.log(`\x1b[35m[demo]\x1b[0m ${message}`)

const children: ChildProcess[] = []
const start = (name: string, command: string, args: string[], env: Record<string, string>) => {
  log(`starting ${name}: ${command} ${args.join(" ")}`)
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  })
  children.push(child)
  return child
}

const shutdown = () => {
  log("shutting down")
  for (const child of children) child.kill("SIGTERM")
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

const waitFor = async (url: string, label: string, tries = 60): Promise<void> => {
  for (let i = 0; i < tries; i += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        log(`${label} is up`)
        return
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${label} did not come up at ${url}`)
}

// 0. Make sure the workspace is built (server + proxy run from dist).
if (
  !existsSync(join(repoRoot, "packages/server/dist/main.js")) ||
  !existsSync(join(repoRoot, "packages/proxy/dist/main.js"))
) {
  log("building workspace (first run)…")
  spawnSync("pnpm", ["exec", "turbo", "run", "build", "--filter=@void/server", "--filter=@void/proxy"], {
    cwd: repoRoot,
    stdio: "inherit",
  })
}

// 1. Parent server — the proxy's target.
start("void server", "node", ["packages/server/dist/main.js"], { PORT: "4000" })
await waitFor(`${PARENT}/health`, "void server")

// 2. Billing dashboard against the parent.
start("dashboard", "pnpm", ["--filter", "@void/web", "dev"], {
  VOID_SERVER_URL: PARENT,
})

// 3. Deploy this app's billing model (no-op when the checksum is active).
const deployed = await billing.connect({ endpoint: PARENT }).deploy()
log(`billing config deployed: ${deployed.status} (v${deployed.version}) ${billing.checksum}`)

// 4. The merchant-side proxy, journaling into the demo folder.
start("void proxy", "node", ["packages/proxy/dist/main.js"], {
  PORT: "4010",
  VOID_UPSTREAM: PARENT,
  VOID_PROXY_DATA: join(here, "..", ".void-proxy"),
})
await waitFor(`${PROXY}/health`, "void proxy")

// 5. The ticketing app itself.
start("helpdesk", "pnpm", ["--filter", "void-ticketing-demo", "app"], {
  VOID_PROXY_URL: PROXY,
})

log("")
log("helpdesk   → http://localhost:3005")
log("dashboard  → http://localhost:3001")
log("proxy      → http://localhost:4010/health")
log("parent     → http://localhost:4000/v1/usage")

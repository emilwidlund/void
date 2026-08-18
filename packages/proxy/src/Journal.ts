import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs"
import { join } from "node:path"

/**
 * Durable store-and-forward state for the proxy, on plain files so a
 * restarted proxy loses nothing:
 *
 *   events.jsonl  one ingested batch per line, append-only
 *   cursor        how many batches have been acknowledged by the upstream
 *   config.json   the last known billing config (checksum + IR)
 *
 * The journal serves two independent purposes: replaying *all* batches
 * rebuilds local metering state after a restart, while the cursor tracks
 * which prefix has already been forwarded upstream. Because replay needs the
 * full history, the journal is append-only and never compacted — a real
 * deployment would snapshot engine state periodically and truncate behind
 * the snapshot.
 */
export class Journal {
  private readonly eventsPath: string
  private readonly cursorPath: string
  private readonly configPath: string

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.eventsPath = join(dataDir, "events.jsonl")
    this.cursorPath = join(dataDir, "cursor")
    this.configPath = join(dataDir, "config.json")
  }

  append(batch: ReadonlyArray<unknown>): void {
    appendFileSync(this.eventsPath, `${JSON.stringify(batch)}\n`)
  }

  allBatches(): ReadonlyArray<ReadonlyArray<unknown>> {
    if (!existsSync(this.eventsPath)) return []
    return readFileSync(this.eventsPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ReadonlyArray<unknown>)
  }

  cursor(): number {
    if (!existsSync(this.cursorPath)) return 0
    const parsed = Number(readFileSync(this.cursorPath, "utf8").trim())
    return Number.isFinite(parsed) ? parsed : 0
  }

  /** Batches not yet acknowledged by the upstream. */
  unsent(): ReadonlyArray<ReadonlyArray<unknown>> {
    return this.allBatches().slice(this.cursor())
  }

  backlog(): number {
    return this.allBatches().length - this.cursor()
  }

  advance(): void {
    writeFileSync(this.cursorPath, String(this.cursor() + 1))
  }

  saveConfig(payload: unknown): void {
    writeFileSync(this.configPath, JSON.stringify(payload))
  }

  loadConfig(): unknown | null {
    if (!existsSync(this.configPath)) return null
    return JSON.parse(readFileSync(this.configPath, "utf8")) as unknown
  }
}

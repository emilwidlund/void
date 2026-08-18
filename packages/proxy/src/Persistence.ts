import { Journal } from "./Journal.js"

/**
 * Where the proxy persists its store-and-forward state. Implement this with
 * your own database to keep billing state in infrastructure you already
 * operate — e.g. a Postgres adapter is one table for batches
 * (`id bigserial, batch jsonb`), one row for the cursor and one for the
 * cached config:
 *
 *   const postgresPersistence = (pool: Pool): PersistenceAdapter => ({
 *     appendBatch: (b) => pool.query("insert into void_batches (batch) values ($1)", [b]),
 *     allBatches:  () => pool.query("select batch from void_batches order by id")
 *                            .then((r) => r.rows.map((row) => row.batch)),
 *     ...
 *   })
 *
 * All methods are async so adapters can be backed by anything; the default
 * file journal simply resolves synchronously.
 */
export interface PersistenceAdapter {
  /** append one ingested batch (append-only; replay depends on full history) */
  appendBatch(batch: ReadonlyArray<unknown>): Promise<void>
  /** every batch ever appended, in order */
  allBatches(): Promise<ReadonlyArray<ReadonlyArray<unknown>>>
  /** how many batches have been acknowledged by the upstream */
  cursor(): Promise<number>
  advanceCursor(): Promise<void>
  saveConfig(payload: unknown): Promise<void>
  loadConfig(): Promise<unknown | null>
}

/** The default adapter: append-only files in `dataDir` (see Journal). */
export const filePersistence = (dataDir: string): PersistenceAdapter => {
  const journal = new Journal(dataDir)
  return {
    appendBatch: async (batch) => journal.append(batch),
    allBatches: async () => journal.allBatches(),
    cursor: async () => journal.cursor(),
    advanceCursor: async () => journal.advance(),
    saveConfig: async (payload) => journal.saveConfig(payload),
    loadConfig: async () => journal.loadConfig()
  }
}

/** Volatile adapter for tests and ephemeral setups. */
export const memoryPersistence = (): PersistenceAdapter => {
  const batches: Array<ReadonlyArray<unknown>> = []
  let cursor = 0
  let config: unknown | null = null
  return {
    appendBatch: async (batch) => {
      batches.push(batch)
    },
    allBatches: async () => [...batches],
    cursor: async () => cursor,
    advanceCursor: async () => {
      cursor += 1
    },
    saveConfig: async (payload) => {
      config = payload
    },
    loadConfig: async () => config
  }
}

/**
 * Dual-write: every mutation goes to both adapters; reads come from the
 * primary. Point the secondary at your warehouse to keep an audit copy of
 * every billing event in your own database.
 */
export const teePersistence = (
  primary: PersistenceAdapter,
  secondary: PersistenceAdapter
): PersistenceAdapter => ({
  appendBatch: async (batch) => {
    await Promise.all([primary.appendBatch(batch), secondary.appendBatch(batch)])
  },
  allBatches: () => primary.allBatches(),
  cursor: () => primary.cursor(),
  advanceCursor: async () => {
    await Promise.all([primary.advanceCursor(), secondary.advanceCursor()])
  },
  saveConfig: async (payload) => {
    await Promise.all([primary.saveConfig(payload), secondary.saveConfig(payload)])
  },
  loadConfig: () => primary.loadConfig()
})

import type { BillingIr } from "@void/compiler"
import { Data, Effect, Ref } from "effect"
import { createHash } from "node:crypto"
import type { DeployPayload } from "./Domain.js"

export const checksumIr = (ir: BillingIr): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(ir)).digest("hex")}`

export class ChecksumMismatch extends Data.TaggedError("ChecksumMismatch")<{
  readonly expected: string
  readonly received: string
}> {}

export interface ConfigVersion {
  readonly version: number
  readonly checksum: string
  readonly ir: BillingIr
  readonly deployedAt: string
  readonly source: string | undefined
}

export type DeployOutcome =
  | { readonly status: "accepted"; readonly version: number }
  | { readonly status: "unchanged"; readonly version: number }

export interface ActiveDescription {
  readonly version: number
  readonly checksum: string
  readonly deployed_at: string
  readonly source: string | null
  readonly meters: number
  readonly products: number
  readonly ir: BillingIr
}

/** The wire shape of the active config, shared by `/v1/config` and the SSE stream. */
export const describeActive = (
  active: ConfigVersion | undefined
): ActiveDescription | null =>
  active === undefined
    ? null
    : {
        version: active.version,
        checksum: active.checksum,
        deployed_at: active.deployedAt,
        source: active.source ?? null,
        meters: active.ir.meters.length,
        products: active.ir.products.length,
        ir: active.ir
      }

export class ConfigStore extends Effect.Service<ConfigStore>()("ConfigStore", {
  effect: Effect.gen(function* () {
    const versions = yield* Ref.make<ReadonlyArray<ConfigVersion>>([])

    const active = Ref.get(versions).pipe(Effect.map((all) => all[all.length - 1]))

    const deploy = (payload: DeployPayload): Effect.Effect<DeployOutcome, ChecksumMismatch> =>
      Effect.gen(function* () {
        const computed = checksumIr(payload.ir)
        if (computed !== payload.checksum) {
          return yield* new ChecksumMismatch({ expected: computed, received: payload.checksum })
        }
        const current = yield* active
        if (current !== undefined && current.checksum === computed) {
          return { status: "unchanged", version: current.version } as const
        }
        const next: ConfigVersion = {
          version: (current?.version ?? 0) + 1,
          checksum: computed,
          ir: payload.ir,
          deployedAt: new Date().toISOString(),
          source: payload.meta?.source
        }
        yield* Ref.update(versions, (all) => [...all, next])
        return { status: "accepted", version: next.version } as const
      })

    return { deploy, active, history: Ref.get(versions) } as const
  })
}) {}

import type { BillingIr } from "@void/compiler"
import type { ClientOptions, VoidClient } from "./Client.js"
import { createClient } from "./Client.js"
import { aiMeterEvent, collectEventNames, compileConfig } from "./Compile.js"
import type {
  AiMeterConfig,
  AiModelsOf,
  EntitlementIdOf,
  EventNameOf,
  InvariantConfig,
  MeterConfig,
  MeterIdOf,
  MeterIdsOf,
  OverrideConfig,
  ProductConfig,
  ProductIdOf
} from "./Config.js"
import { isAiConfig } from "./Config.js"

export * from "./Client.js"
export { aiMeterEvent, checksumIr } from "./Compile.js"
export * from "./Config.js"

/** A connected client, with one bound model per AI meter under `ai`. */
export type ConnectedClient<C> = VoidClient<
  MeterIdOf<C>,
  EntitlementIdOf<C> & string,
  EventNameOf<C>
> & {
  /** AI meters' models, wrapped and usage-tracked, keyed by meter id */
  readonly ai: AiModelsOf<C>
}

/** What `defineConfig` returns: the compiled artifact plus a typed client factory. */
export interface VoidConfig<C> {
  readonly config: C
  /** the canonical IR — byte-identical to what the `.void` compiler emits */
  readonly ir: BillingIr
  /** sha256 over the compact IR JSON — the deploy identity */
  readonly checksum: string
  /** invariant violations softened by `else: "warn"` */
  readonly warnings: ReadonlyArray<string>
  /** typed ids, handy for app-side signatures */
  readonly meters: ReadonlyArray<MeterIdOf<C>>
  readonly products: ReadonlyArray<ProductIdOf<C>>
  /** every event name the config mentions, for app-side signatures */
  readonly events: ReadonlyArray<EventNameOf<C>>
  /** connect to a void server with meter/entitlement/event ids typed to this config */
  connect(options: ClientOptions): ConnectedClient<C>
}

/**
 * The TypeScript frontend to void: your customers' state — entitlements,
 * meters, usage, AI models — as one typed config, with billing derived from
 * it as a side effect. Compiles to the same checksummed IR as `.void` files
 * (throwing when a static invariant is violated — negotiated overrides
 * included) and returns a client whose meter, product and entitlement ids
 * are literal types.
 *
 * AI is declared as meters: a `metered(model)` entry (from `@void/sdk/ai`)
 * compiles to a standard meter and surfaces the wrapped, usage-tracked model
 * on the connected client as `client.ai.<meter key>`.
 */
export const defineConfig = <
  const M extends Readonly<Record<string, MeterConfig | AiMeterConfig>>,
  const P extends Readonly<Record<string, ProductConfig<MeterIdsOf<M>>>>,
  const O extends Readonly<
    Record<string, OverrideConfig<MeterIdsOf<M>>>
  > = Record<never, never>
>(config: {
  readonly meters: M
  readonly products: P
  readonly invariants?: ReadonlyArray<InvariantConfig<MeterIdsOf<M>>>
  readonly overrides?: O
}): VoidConfig<{
  readonly meters: M
  readonly products: P
  readonly overrides: O
}> => {
  type C = { readonly meters: M; readonly products: P; readonly overrides: O }
  const { checksum, ir, warnings } = compileConfig(config)
  return {
    config: config as never,
    ir,
    checksum,
    warnings,
    // IR-derived so AI meters show their expanded per-token-class ids
    meters: [
      ...ir.meters.map((meter) => meter.id),
      ...ir.outcomes.map((outcome) => outcome.id)
    ] as Array<MeterIdOf<C>>,
    products: Object.keys(config.products) as Array<ProductIdOf<C>>,
    events: collectEventNames(ir) as Array<EventNameOf<C>>,
    connect: (options) => {
      const client = createClient<
        MeterIdOf<C>,
        EntitlementIdOf<C> & string,
        EventNameOf<C>
      >(ir, checksum, options)
      const ai = Object.fromEntries(
        Object.entries(config.meters).flatMap(([key, meter]) =>
          isAiConfig(meter) ? [[key, meter.bind(client, aiMeterEvent(key, meter))]] : []
        )
      ) as AiModelsOf<C>
      return Object.assign(client, { ai })
    }
  }
}

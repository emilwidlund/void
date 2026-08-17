import type { BillingIr } from "@void/compiler"
import type { ClientOptions, VoidClient } from "./Client.js"
import { createClient } from "./Client.js"
import { collectEventNames, compileConfig } from "./Compile.js"
import type {
  BillingConfigShape,
  EntitlementIdOf,
  EventNameOf,
  MeterIdOf,
  ProductIdOf
} from "./Config.js"

export * from "./Client.js"
export { checksumIr } from "./Compile.js"
export * from "./Config.js"

/** What `defineBilling` returns: the compiled artifact plus a typed client factory. */
export interface Billing<C> {
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
  connect(
    options: ClientOptions
  ): VoidClient<MeterIdOf<C>, EntitlementIdOf<C> & string, EventNameOf<C>>
}

/**
 * The TypeScript frontend to void. Compiles the config to the same
 * checksummed IR as `.void` files (throwing when a static invariant is
 * violated — negotiated overrides included) and returns a client whose
 * meter, product and entitlement ids are literal types.
 */
export const defineBilling = <const C extends BillingConfigShape<C>>(
  config: C
): Billing<C> => {
  const { checksum, ir, warnings } = compileConfig(config)
  return {
    config,
    ir,
    checksum,
    warnings,
    meters: Object.keys(config.meters) as Array<MeterIdOf<C>>,
    products: Object.keys(config.products) as Array<ProductIdOf<C>>,
    events: collectEventNames(ir) as Array<EventNameOf<C>>,
    connect: (options) => createClient(ir, checksum, options)
  }
}

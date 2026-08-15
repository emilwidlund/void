import type { Span } from "./Diagnostic.js"

export interface Identifier {
  readonly name: string
  readonly span: Span
}

export interface PropertyPath {
  readonly segments: ReadonlyArray<string>
  readonly span: Span
}

export type Literal =
  | { readonly _tag: "StringLiteral"; readonly value: string; readonly span: Span }
  | { readonly _tag: "NumberLiteral"; readonly value: string; readonly span: Span }
  | { readonly _tag: "BooleanLiteral"; readonly value: boolean; readonly span: Span }

export type ComparisonOp = "==" | "!=" | ">" | ">=" | "<" | "<="

export type FilterExpr =
  | {
      readonly _tag: "Comparison"
      readonly path: PropertyPath
      readonly op: ComparisonOp
      readonly value: Literal
      readonly span: Span
    }
  | {
      readonly _tag: "Logical"
      readonly op: "and" | "or"
      readonly left: FilterExpr
      readonly right: FilterExpr
      readonly span: Span
    }

export type Aggregate =
  | { readonly _tag: "Count"; readonly span: Span }
  | {
      readonly _tag: "PropertyAggregate"
      readonly fn: "sum" | "max" | "min" | "avg" | "unique"
      readonly path: PropertyPath
      readonly span: Span
    }

export type MeterField =
  | { readonly _tag: "FilterField"; readonly expr: FilterExpr; readonly span: Span }
  | { readonly _tag: "AggregateField"; readonly aggregate: Aggregate; readonly span: Span }
  | { readonly _tag: "UnitField"; readonly name: Identifier; readonly span: Span }
  /** `reverse_on <filter> [within <n> <time-unit>]` — events that unbill a prior charge */
  | {
      readonly _tag: "ReverseField"
      readonly expr: FilterExpr
      readonly window: {
        readonly value: string
        readonly unit: Identifier
        readonly span: Span
      } | null
      readonly span: Span
    }

export interface MeterDecl {
  readonly _tag: "MeterDecl"
  readonly id: Identifier
  readonly fields: ReadonlyArray<MeterField>
  readonly span: Span
}

export interface Money {
  readonly amount: string
  readonly amountSpan: Span
  readonly currency: string
  readonly currencySpan: Span
}

export type Interval = "monthly" | "yearly" | "weekly" | "daily"

export type PricingField =
  | {
      readonly _tag: "PerUnitField"
      readonly money: Money
      /** optional `per <unit>` suffix: what one priced unit is */
      readonly per: Identifier | null
      readonly span: Span
    }
  | { readonly _tag: "IncludedField"; readonly value: string; readonly span: Span }
  /** Cost-derived pricing: `margin 60%` — the value is the percentage as written. */
  | { readonly _tag: "MarginField"; readonly value: string; readonly span: Span }

export type EntitlementField =
  | { readonly _tag: "LimitField"; readonly value: string; readonly span: Span }
  | { readonly _tag: "EntitlementMeterField"; readonly meter: Identifier; readonly span: Span }

export type ProductField =
  | { readonly _tag: "NameField"; readonly value: string; readonly span: Span }
  | {
      readonly _tag: "RecurringPriceField"
      readonly interval: Interval
      readonly money: Money
      readonly span: Span
    }
  | {
      readonly _tag: "MeterBindingField"
      /** which namespace the binding references: `meter x { ... }` or `outcome x { ... }` */
      readonly kind: "meter" | "outcome"
      readonly meter: Identifier
      readonly fields: ReadonlyArray<PricingField>
      readonly span: Span
    }
  | {
      readonly _tag: "EntitlementField"
      readonly id: Identifier
      readonly fields: ReadonlyArray<EntitlementField>
      readonly span: Span
    }

export interface ProductDecl {
  readonly _tag: "ProductDecl"
  readonly id: Identifier
  readonly fields: ReadonlyArray<ProductField>
  readonly span: Span
}

export type InvariantThreshold =
  | { readonly _tag: "MoneyThreshold"; readonly money: Money }
  | { readonly _tag: "PercentThreshold"; readonly value: string; readonly span: Span }
  | { readonly _tag: "NumberThreshold"; readonly value: string; readonly span: Span }

/** One `metric(arg) op threshold [else action]` condition inside an invariant block. */
export interface InvariantCondition {
  readonly metric: Identifier
  /** a meter id, or the keyword `customer` for runtime per-customer checks */
  readonly arg: Identifier
  readonly op: ComparisonOp
  readonly threshold: InvariantThreshold
  /** optional remedy applied when the condition is violated */
  readonly behavior: Identifier | null
  readonly span: Span
}

export interface InvariantDecl {
  readonly _tag: "InvariantDecl"
  readonly name: string
  readonly nameSpan: Span
  readonly conditions: ReadonlyArray<InvariantCondition>
  readonly span: Span
}

/**
 * `override customer "acme" { ... }` — a negotiated deal as config: prices
 * and entitlements that replace the list versions for one customer, with an
 * optional expiry.
 */
export interface OverrideDecl {
  readonly _tag: "OverrideDecl"
  readonly customer: string
  readonly customerSpan: Span
  /** ISO date string, e.g. "2027-01-01" */
  readonly until: { readonly value: string; readonly span: Span } | null
  readonly fields: ReadonlyArray<ProductField>
  readonly span: Span
}

export type OutcomeField =
  /** which event property identifies one instance of this outcome */
  | { readonly _tag: "CorrelateField"; readonly path: PropertyPath; readonly span: Span }
  /** one link in the chain — steps must occur in declaration order */
  | { readonly _tag: "StepField"; readonly expr: FilterExpr; readonly span: Span }
  /** aborts an in-flight chain, or reverses a completed one within the window */
  | {
      readonly _tag: "FailField"
      readonly expr: FilterExpr
      readonly window: {
        readonly value: string
        readonly unit: Identifier
        readonly span: Span
      } | null
      readonly span: Span
    }

/**
 * `outcome <id> { ... }` — success as a correlated chain of events. A
 * completed chain counts one scalar unit of usage under the outcome's id,
 * so outcomes are priced and gated exactly like meters.
 */
export interface OutcomeDecl {
  readonly _tag: "OutcomeDecl"
  readonly id: Identifier
  readonly fields: ReadonlyArray<OutcomeField>
  readonly span: Span
}

export type Decl = MeterDecl | ProductDecl | InvariantDecl | OverrideDecl | OutcomeDecl

export interface SourceFile {
  readonly decls: ReadonlyArray<Decl>
}

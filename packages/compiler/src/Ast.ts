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
  | { readonly _tag: "PerUnitField"; readonly money: Money; readonly span: Span }
  | { readonly _tag: "IncludedField"; readonly value: string; readonly span: Span }

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
      readonly meter: Identifier
      readonly fields: ReadonlyArray<PricingField>
      readonly span: Span
    }

export interface ProductDecl {
  readonly _tag: "ProductDecl"
  readonly id: Identifier
  readonly fields: ReadonlyArray<ProductField>
  readonly span: Span
}

export type Decl = MeterDecl | ProductDecl

export interface SourceFile {
  readonly decls: ReadonlyArray<Decl>
}

import type { IrAggregation, IrFilter } from "@void/compiler"
import type { IngestEvent, PropertyValue } from "./Domain.js"

export type AggregationState =
  | { readonly type: "count"; readonly count: number }
  | { readonly type: "sum"; readonly sum: number }
  | { readonly type: "max"; readonly max: number | null }
  | { readonly type: "min"; readonly min: number | null }
  | { readonly type: "avg"; readonly sum: number; readonly count: number }
  | { readonly type: "unique"; readonly values: ReadonlySet<PropertyValue> }

export const initialState = (aggregation: IrAggregation): AggregationState => {
  switch (aggregation.type) {
    case "count":
      return { type: "count", count: 0 }
    case "sum":
      return { type: "sum", sum: 0 }
    case "max":
      return { type: "max", max: null }
    case "min":
      return { type: "min", min: null }
    case "avg":
      return { type: "avg", sum: 0, count: 0 }
    case "unique":
      return { type: "unique", values: new Set() }
  }
}

/**
 * Resolves an IR property path against an event: `event.name` is the event
 * name, any other `event.<key>` reads from the event's properties bag.
 */
export const resolveProperty = (
  property: string,
  event: IngestEvent
): PropertyValue | undefined => {
  const segments = property.split(".")
  if (segments.length !== 2 || segments[0] !== "event") return undefined
  const key = segments[1]!
  return key === "name" ? event.name : event.properties[key]
}

export const matchesFilter = (filter: IrFilter | null, event: IngestEvent): boolean => {
  if (filter === null) return true
  if (filter.type === "comparison") {
    const actual = resolveProperty(filter.property, event)
    if (filter.op === "eq") return actual === filter.value
    if (filter.op === "ne") return actual !== filter.value
    if (typeof actual !== "number" || typeof filter.value !== "number") return false
    switch (filter.op) {
      case "gt":
        return actual > filter.value
      case "gte":
        return actual >= filter.value
      case "lt":
        return actual < filter.value
      case "lte":
        return actual <= filter.value
    }
  }
  return filter.type === "and"
    ? filter.operands.every((f) => matchesFilter(f, event))
    : filter.operands.some((f) => matchesFilter(f, event))
}

/**
 * Folds one matching event into the aggregation state. Events whose aggregated
 * property is missing or non-numeric (for numeric aggregations) leave the
 * state unchanged.
 */
export const applyEvent = (
  state: AggregationState,
  aggregation: IrAggregation,
  event: IngestEvent
): AggregationState => {
  if (state.type === "count") {
    return { type: "count", count: state.count + 1 }
  }

  const property = aggregation.type === "count" ? undefined : aggregation.property
  const value = property === undefined ? undefined : resolveProperty(property, event)

  if (state.type === "unique") {
    if (value === undefined) return state
    if (state.values.has(value)) return state
    return { type: "unique", values: new Set(state.values).add(value) }
  }

  if (typeof value !== "number") return state
  switch (state.type) {
    case "sum":
      return { type: "sum", sum: state.sum + value }
    case "max":
      return { type: "max", max: state.max === null ? value : Math.max(state.max, value) }
    case "min":
      return { type: "min", min: state.min === null ? value : Math.min(state.min, value) }
    case "avg":
      return { type: "avg", sum: state.sum + value, count: state.count + 1 }
  }
}

/** Collapses an aggregation state into the billable value. */
export const finalize = (state: AggregationState): number => {
  switch (state.type) {
    case "count":
      return state.count
    case "sum":
      return state.sum
    case "max":
      return state.max ?? 0
    case "min":
      return state.min ?? 0
    case "avg":
      return state.count === 0 ? 0 : state.sum / state.count
    case "unique":
      return state.values.size
  }
}

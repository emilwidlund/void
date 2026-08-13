import type { IrAggregation, IrFilter } from "@void/compiler"
import { describe, expect, it } from "vitest"
import type { IngestEvent } from "../src/Domain.js"
import { applyEvent, finalize, initialState, matchesFilter, resolveProperty } from "../src/Metering.js"

const event = (name: string, properties: IngestEvent["properties"] = {}): IngestEvent => ({
  name,
  properties
})

const comparison = (
  property: string,
  op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte",
  value: string | number | boolean
): IrFilter => ({ type: "comparison", property, op, value })

describe("resolveProperty", () => {
  it("resolves event.name to the event name", () => {
    expect(resolveProperty("event.name", event("api.request"))).toBe("api.request")
  })

  it("resolves other keys from the properties bag", () => {
    expect(resolveProperty("event.duration_s", event("x", { duration_s: 3 }))).toBe(3)
    expect(resolveProperty("event.missing", event("x"))).toBeUndefined()
  })

  it("only supports two-segment event paths", () => {
    expect(resolveProperty("customer.plan", event("x", { plan: "pro" }))).toBeUndefined()
    expect(resolveProperty("event.a.b", event("x", { a: 1 }))).toBeUndefined()
  })
})

describe("matchesFilter", () => {
  it("null filter matches everything", () => {
    expect(matchesFilter(null, event("anything"))).toBe(true)
  })

  it("compares with eq/ne on any type and ordering on numbers", () => {
    expect(matchesFilter(comparison("event.name", "eq", "a"), event("a"))).toBe(true)
    expect(matchesFilter(comparison("event.name", "ne", "a"), event("b"))).toBe(true)
    expect(matchesFilter(comparison("event.n", "gt", 5), event("x", { n: 6 }))).toBe(true)
    expect(matchesFilter(comparison("event.n", "lte", 5), event("x", { n: 5 }))).toBe(true)
    expect(matchesFilter(comparison("event.flag", "eq", true), event("x", { flag: true }))).toBe(
      true
    )
  })

  it("ordering comparisons never match non-numeric values", () => {
    expect(matchesFilter(comparison("event.n", "gt", 5), event("x", { n: "6" }))).toBe(false)
    expect(matchesFilter(comparison("event.n", "gt", 5), event("x"))).toBe(false)
  })

  it("evaluates and/or logic", () => {
    const filter: IrFilter = {
      type: "and",
      operands: [
        comparison("event.name", "eq", "compute.done"),
        {
          type: "or",
          operands: [
            comparison("event.status", "eq", "success"),
            comparison("event.retried", "eq", true)
          ]
        }
      ]
    }
    expect(matchesFilter(filter, event("compute.done", { status: "success" }))).toBe(true)
    expect(matchesFilter(filter, event("compute.done", { status: "failed", retried: true }))).toBe(
      true
    )
    expect(matchesFilter(filter, event("compute.done", { status: "failed" }))).toBe(false)
    expect(matchesFilter(filter, event("other", { status: "success" }))).toBe(false)
  })
})

describe("aggregations", () => {
  const fold = (aggregation: IrAggregation, events: ReadonlyArray<IngestEvent>): number =>
    finalize(events.reduce((s, e) => applyEvent(s, aggregation, e), initialState(aggregation)))

  const durations = (...values: ReadonlyArray<number>) =>
    values.map((duration_s) => event("compute.done", { duration_s }))

  it("count", () => {
    expect(fold({ type: "count" }, durations(1, 2, 3))).toBe(3)
  })

  it("sum / max / min / avg over a property", () => {
    const aggregate = (type: "sum" | "max" | "min" | "avg") =>
      fold({ type, property: "event.duration_s" }, durations(4, 10, 1))
    expect(aggregate("sum")).toBe(15)
    expect(aggregate("max")).toBe(10)
    expect(aggregate("min")).toBe(1)
    expect(aggregate("avg")).toBe(5)
  })

  it("unique counts distinct values", () => {
    const events = ["a", "b", "a", "c", "b"].map((user) => event("login", { user }))
    expect(fold({ type: "unique", property: "event.user" }, events)).toBe(3)
  })

  it("ignores events with a missing or non-numeric aggregated property", () => {
    const aggregation: IrAggregation = { type: "sum", property: "event.duration_s" }
    const events = [
      ...durations(5),
      event("compute.done"),
      event("compute.done", { duration_s: "oops" })
    ]
    expect(fold(aggregation, events)).toBe(5)
  })

  it("finalizes empty states to zero", () => {
    expect(finalize(initialState({ type: "max", property: "event.n" }))).toBe(0)
    expect(finalize(initialState({ type: "avg", property: "event.n" }))).toBe(0)
  })
})

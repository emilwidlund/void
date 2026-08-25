/**
 * `@void/sdk/ai` — AI models as meters, for the Vercel AI SDK / AI Gateway.
 *
 * Declare a model as a meter with `metered` and connect:
 *
 *   const config = defineConfig({
 *     meters: {
 *       assistant: metered(gateway("openai/gpt-4o")),
 *     },
 *     products: { ... },
 *   })
 *   const voidClient = config.connect({ endpoint })
 *
 * The entry compiles to a standard meter (event `ai.assistant`, summing
 * `total_tokens`) and the client exposes the wrapped model:
 *
 *   await generateText({
 *     model: voidClient.ai.assistant,
 *     prompt,
 *     providerOptions: { void: voidOptions({ customer: "acme" }) },
 *   })
 *
 * Every call lands on the customer's record with token counts as properties
 * and the cost of serving it attached as `_cost`. Cost resolution, first
 * match wins:
 *   1. the `cost` resolver option (full control, may be async)
 *   2. what the AI Gateway reports for the request (`providerMetadata.gateway`)
 *   3. the `pricing` table (per-million-token rates by model id)
 * When none resolves, the event is still tracked — with token counts, just
 * without `_cost`.
 *
 * Importing this module requires the optional `ai` peer dependency.
 */
import type {
  JSONObject,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata
} from "@ai-sdk/provider"
import type { GatewayModelId } from "ai"
import { wrapLanguageModel } from "ai"
import type {
  AggregateSpec,
  AiEventProperty,
  AiMeterConfig,
  AiTrackTarget,
  Money,
  Suggest,
  TokenPricing,
  UnitName
} from "./Config.js"
import { money } from "./Config.js"

export type { AiEventProperty, AiMeterConfig, AiTrackTarget, TokenPricing }

export interface TokenUsage {
  readonly inputTokens: number | undefined
  readonly outputTokens: number | undefined
  readonly totalTokens: number | undefined
  /** cached input tokens read (prompt-cache hits) */
  readonly cachedInputTokens: number | undefined
  readonly reasoningTokens: number | undefined
}

/** Everything known about one finished model call. */
export interface AiCallInfo {
  /** the model that answered (response metadata when present, else the wrapped model's id) */
  readonly model: string
  readonly provider: string
  readonly usage: TokenUsage
  readonly finishReason: string
  readonly streamed: boolean
  readonly durationMs: number
  /** raw provider metadata (e.g. the `gateway` namespace) for custom cost resolvers */
  readonly providerMetadata: SharedV4ProviderMetadata | undefined
}

/** Options for `metered` — how one AI meter tracks, aggregates and prices. */
export interface MeteredOptions {
  /** usage event tracked per call; defaults to `ai.<meter key>` */
  readonly event?: string
  /** how the meter aggregates those events; defaults to `{ sum: "total_tokens" }` */
  readonly aggregate?: AggregateSpec<AiEventProperty>
  readonly unit?: UnitName
  /** default customer; a function can pull it from request context per call */
  readonly customer?: string | ((info: AiCallInfo) => string | undefined)
  /** extra event properties, merged under the automatic ones */
  readonly properties?:
    | Readonly<Record<string, string | number | boolean>>
    | ((info: AiCallInfo) => Readonly<Record<string, string | number | boolean>>)
  /** custom cost resolver — takes precedence over gateway metadata and `pricing` */
  readonly cost?: (
    info: AiCallInfo
  ) => Money | undefined | PromiseLike<Money | undefined>
  /** fallback rates keyed by model id ("openai/gpt-4o"), "*" as wildcard */
  readonly pricing?: Readonly<Record<string, TokenPricing>>
  /** tracking failures never break the model call; they land here (default: console.warn) */
  readonly onTrackError?: (error: unknown, info: AiCallInfo) => void
  /**
   * Middleware logging: `true` for the built-in console logger, a function
   * for a custom structured sink, `false` to force off. When omitted, the
   * console logger turns on while `VOID_AI_DEBUG` is set in the environment.
   */
  readonly log?: boolean | AiLogger
}

/** How a call's `_cost` was resolved. */
export type AiCostSource = "resolver" | "gateway" | "pricing" | "none"

/** Everything the middleware sees, as structured lifecycle events. */
export type AiLogEvent =
  | {
      readonly type: "call"
      readonly event: string
      readonly model: string
      readonly provider: string
      readonly streamed: boolean
      /** truncated text of the last prompt message */
      readonly prompt?: string
      readonly customer?: string
    }
  | { readonly type: "finish"; readonly event: string; readonly info: AiCallInfo }
  | {
      readonly type: "cost"
      readonly event: string
      readonly source: AiCostSource
      readonly cost?: Money
    }
  | {
      readonly type: "track"
      readonly event: string
      readonly customer?: string
      readonly properties: Readonly<Record<string, string | number | boolean>>
      readonly cost?: Money
    }
  | { readonly type: "skip"; readonly event: string; readonly reason: "track: false" }
  | {
      readonly type: "abort"
      readonly event: string
      readonly reason: "stream ended without a finish part — nothing recorded"
    }
  | { readonly type: "error"; readonly event: string; readonly error: unknown }

export type AiLogger = (entry: AiLogEvent) => void

const formatMoney = (value: Money): string => {
  // display only — the tracked cost stays exact
  const amount = Number((value.minor ? value.amount / 100 : value.amount).toFixed(6))
  return value.currency === "USD" ? `$${amount}` : `${amount} ${value.currency}`
}

/** The built-in sink: one compact console line per lifecycle event. */
export const consoleAiLogger: AiLogger = (entry) => {
  const tag = `[void/ai] ${entry.event}`
  switch (entry.type) {
    case "call":
      console.log(
        `${tag} ← ${entry.model} (${entry.provider})${entry.streamed ? " stream" : ""}` +
          `${entry.customer !== undefined ? ` customer=${entry.customer}` : ""}` +
          `${entry.prompt !== undefined ? ` "${entry.prompt}"` : ""}`
      )
      break
    case "finish": {
      const { usage, finishReason, durationMs } = entry.info
      console.log(
        `${tag} finished: ${finishReason} · in ${usage.inputTokens ?? "?"}` +
          `${usage.cachedInputTokens !== undefined ? ` (cached ${usage.cachedInputTokens})` : ""}` +
          ` · out ${usage.outputTokens ?? "?"} · ${durationMs}ms`
      )
      break
    }
    case "cost":
      console.log(
        entry.cost !== undefined
          ? `${tag} cost ${formatMoney(entry.cost)} (${entry.source})`
          : `${tag} no cost resolved`
      )
      break
    case "track":
      console.log(
        `${tag} → track${entry.customer !== undefined ? ` customer=${entry.customer}` : ""}` +
          `${entry.cost !== undefined ? ` cost=${formatMoney(entry.cost)}` : ""} ` +
          JSON.stringify(entry.properties)
      )
      break
    case "skip":
      console.log(`${tag} skipped (${entry.reason})`)
      break
    case "abort":
      console.log(`${tag} ${entry.reason}`)
      break
    case "error":
      console.warn(`${tag} failed to track:`, entry.error)
      break
  }
}

const resolveLogger = (log: boolean | AiLogger | undefined): AiLogger | undefined => {
  if (typeof log === "function") return log
  if (log === true) return consoleAiLogger
  if (log === false) return undefined
  return typeof process !== "undefined" && process.env?.["VOID_AI_DEBUG"]
    ? consoleAiLogger
    : undefined
}

/** Text of the last prompt message, truncated — for the `call` log entry. */
const promptPreview = (prompt: unknown): string | undefined => {
  try {
    const messages = prompt as ReadonlyArray<{ readonly content: unknown }>
    const content = messages[messages.length - 1]?.content
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (part): part is { type: "text"; text: string } =>
                  typeof part === "object" &&
                  part !== null &&
                  (part as { type?: unknown }).type === "text"
              )
              .map((part) => part.text)
              .join(" ")
          : undefined
    if (text === undefined || text.length === 0) return undefined
    return text.length > 120 ? `${text.slice(0, 117)}...` : text
  } catch {
    return undefined
  }
}

/** Per-call overrides, passed as `providerOptions: { void: voidOptions({...}) }`. */
export interface VoidCallOptions {
  readonly customer?: string
  readonly event?: string
  readonly properties?: Readonly<Record<string, string | number | boolean>>
  /** set false to not record this call */
  readonly track?: boolean
}

/** Typed helper for the `providerOptions.void` namespace. */
export const voidOptions = (options: VoidCallOptions): JSONObject =>
  options as unknown as JSONObject

/**
 * Typed pricing table for `metered`'s `pricing` option: AI Gateway model ids
 * autocomplete, `"*"` is the wildcard, and any other model id string is
 * still accepted (for plain providers whose ids the gateway doesn't know).
 */
export const modelPricing = (
  table: Readonly<Partial<Record<GatewayModelId | "*", TokenPricing>>>
): Readonly<Record<string, TokenPricing>> =>
  table as Readonly<Record<string, TokenPricing>>

const toTokenUsage = (usage: LanguageModelV4Usage): TokenUsage => {
  const input = usage.inputTokens.total
  const output = usage.outputTokens.total
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens:
      input === undefined && output === undefined
        ? undefined
        : (input ?? 0) + (output ?? 0),
    cachedInputTokens: usage.inputTokens.cacheRead,
    reasoningTokens: usage.outputTokens.reasoning
  }
}

// typed by AiEventProperty so the emitted keys can't drift from what
// AI meters' `aggregate` option suggests
const autoProperties = (
  info: AiCallInfo
): Partial<Record<AiEventProperty, string | number | boolean>> => {
  const properties: Partial<Record<AiEventProperty, string | number | boolean>> = {
    model: info.model,
    provider: info.provider,
    finish_reason: info.finishReason,
    streamed: info.streamed,
    duration_ms: info.durationMs
  }
  const { usage } = info
  if (usage.inputTokens !== undefined) properties["input_tokens"] = usage.inputTokens
  if (usage.outputTokens !== undefined) properties["output_tokens"] = usage.outputTokens
  if (usage.totalTokens !== undefined) properties["total_tokens"] = usage.totalTokens
  if (usage.cachedInputTokens !== undefined)
    properties["cached_input_tokens"] = usage.cachedInputTokens
  if (usage.reasoningTokens !== undefined)
    properties["reasoning_tokens"] = usage.reasoningTokens
  return properties
}

/**
 * The AI Gateway passes its metadata through under the `gateway` namespace;
 * when a usage cost is present there, use it verbatim (USD).
 */
const gatewayCost = (
  metadata: SharedV4ProviderMetadata | undefined
): Money | undefined => {
  const gateway = metadata?.["gateway"]
  if (typeof gateway !== "object" || gateway === null || Array.isArray(gateway))
    return undefined
  const raw = (gateway as Record<string, unknown>)["cost"]
  const amount =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : undefined
  return amount !== undefined && Number.isFinite(amount)
    ? money(amount, "USD")
    : undefined
}

const asMajor = (value: Money): number =>
  value.minor ? value.amount / 100 : value.amount

const tableCost = (
  pricing: Readonly<Record<string, TokenPricing>> | undefined,
  info: AiCallInfo
): Money | undefined => {
  const rates = pricing?.[info.model] ?? pricing?.["*"]
  if (rates === undefined) return undefined
  const cachedRate = rates.cachedInput ?? rates.input
  const cached =
    rates.cachedInput !== undefined ? (info.usage.cachedInputTokens ?? 0) : 0
  const uncachedInput = Math.max(0, (info.usage.inputTokens ?? 0) - cached)
  let total = 0
  let currency: string | undefined
  const add = (tokens: number, rate: Money | undefined) => {
    if (rate === undefined || tokens === 0) return
    total += (tokens / 1_000_000) * asMajor(rate)
    currency ??= rate.currency
  }
  add(uncachedInput, rates.input)
  add(cached, cachedRate)
  add(info.usage.outputTokens ?? 0, rates.output)
  return currency === undefined ? undefined : money(total, currency)
}

interface FinishedCall {
  readonly callOptions: object
  readonly model: { readonly modelId: string; readonly provider: string }
  readonly usage: LanguageModelV4Usage
  readonly finishReason: string
  readonly providerMetadata: SharedV4ProviderMetadata | undefined
  readonly responseModel: string | undefined
  readonly streamed: boolean
  readonly durationMs: number
}

/** `MeteredOptions` with the binding resolved — what the middleware runs on. */
export interface MeteredMiddlewareOptions
  extends Omit<MeteredOptions, "event" | "aggregate" | "unit"> {
  readonly client: AiTrackTarget
  readonly event: string
}

/**
 * The middleware itself, for composing manually via `wrapLanguageModel`.
 * Most callers declare `metered(...)` meters and use `client.ai.<key>`.
 */
export const meteredMiddleware = (
  options: MeteredMiddlewareOptions
): LanguageModelV4Middleware => {
  const log = resolveLogger(options.log)
  // per-call overrides survive transformParams via the params object identity
  const perCall = new WeakMap<object, VoidCallOptions>()

  const report = async (call: FinishedCall): Promise<void> => {
    const overrides = perCall.get(call.callOptions)
    const event = overrides?.event ?? options.event
    if (overrides?.track === false) {
      log?.({ type: "skip", event, reason: "track: false" })
      return
    }
    const info: AiCallInfo = {
      model: call.responseModel ?? call.model.modelId,
      provider: call.model.provider,
      usage: toTokenUsage(call.usage),
      finishReason: call.finishReason,
      streamed: call.streamed,
      durationMs: call.durationMs,
      providerMetadata: call.providerMetadata
    }
    log?.({ type: "finish", event, info })
    try {
      let source: AiCostSource = "none"
      let cost = options.cost !== undefined ? await options.cost(info) : undefined
      if (cost !== undefined) source = "resolver"
      else {
        cost = gatewayCost(info.providerMetadata)
        if (cost !== undefined) source = "gateway"
        else {
          cost = tableCost(options.pricing, info)
          if (cost !== undefined) source = "pricing"
        }
      }
      log?.({ type: "cost", event, source, ...(cost !== undefined ? { cost } : {}) })
      const customer =
        overrides?.customer ??
        (typeof options.customer === "function"
          ? options.customer(info)
          : options.customer)
      const configured =
        typeof options.properties === "function"
          ? options.properties(info)
          : options.properties
      const properties = {
        ...autoProperties(info),
        ...configured,
        ...overrides?.properties
      }
      await options.client.track(event, {
        properties,
        ...(customer !== undefined ? { customer } : {}),
        ...(cost !== undefined ? { cost } : {})
      })
      log?.({
        type: "track",
        event,
        properties,
        ...(customer !== undefined ? { customer } : {}),
        ...(cost !== undefined ? { cost } : {})
      })
    } catch (error) {
      log?.({ type: "error", event, error })
      if (options.onTrackError !== undefined) options.onTrackError(error, info)
      else if (log === undefined)
        console.warn("[@void/sdk/ai] failed to track usage event:", error)
    }
  }

  const logCall = (
    params: { readonly prompt: unknown },
    model: { readonly modelId: string; readonly provider: string },
    streamed: boolean
  ): void => {
    if (log === undefined) return
    const overrides = perCall.get(params)
    const preview = promptPreview(params.prompt)
    log({
      type: "call",
      event: overrides?.event ?? options.event,
      model: model.modelId,
      provider: model.provider,
      streamed,
      ...(preview !== undefined ? { prompt: preview } : {}),
      ...(overrides?.customer !== undefined ? { customer: overrides.customer } : {})
    })
  }

  return {
    specificationVersion: "v4",

    transformParams: async ({ params }) => {
      const perCallOptions = params.providerOptions?.["void"]
      if (perCallOptions === undefined) return params
      // strip our namespace so it never reaches the provider's wire request
      const { void: _void, ...rest } = params.providerOptions ?? {}
      const next = { ...params, providerOptions: rest }
      perCall.set(next, perCallOptions as VoidCallOptions)
      return next
    },

    wrapGenerate: async ({ doGenerate, params, model }) => {
      const started = Date.now()
      logCall(params, model, false)
      const result = await doGenerate()
      await report({
        callOptions: params,
        model,
        usage: result.usage,
        finishReason: result.finishReason.unified,
        providerMetadata: result.providerMetadata,
        responseModel: result.response?.modelId,
        streamed: false,
        durationMs: Date.now() - started
      })
      return result
    },

    wrapStream: async ({ doStream, params, model }) => {
      const started = Date.now()
      logCall(params, model, true)
      const { stream, ...rest } = await doStream()
      let finish: Extract<LanguageModelV4StreamPart, { type: "finish" }> | undefined
      let responseModel: string | undefined
      return {
        ...rest,
        stream: stream.pipeThrough(
          new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            transform(part, controller) {
              if (part.type === "finish") finish = part
              else if (part.type === "response-metadata" && part.modelId !== undefined)
                responseModel = part.modelId
              controller.enqueue(part)
            },
            // aborted/errored streams never see a finish part and aren't recorded
            async flush() {
              if (finish === undefined) {
                log?.({
                  type: "abort",
                  event: perCall.get(params)?.event ?? options.event,
                  reason: "stream ended without a finish part — nothing recorded"
                })
                return
              }
              await report({
                callOptions: params,
                model,
                usage: finish.usage,
                finishReason: finish.finishReason.unified,
                providerMetadata: finish.providerMetadata,
                responseModel,
                streamed: true,
                durationMs: Date.now() - started
              })
            }
          })
        )
      }
    }
  }
}

type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"]
type WrappedModel = ReturnType<typeof wrapLanguageModel>

/**
 * Declare an AI model as a meter:
 *
 *   meters: {
 *     assistant: metered(gateway("openai/gpt-4o")),
 *   }
 *
 * The entry compiles to one standard meter per token class —
 * `assistant.input_tokens`, `assistant.cached_input_tokens` and
 * `assistant.output_tokens`, all filtering `ai.assistant` (override with
 * `event`) — because token classes are priced differently; an explicit
 * `aggregate` compiles to a single meter named `assistant` instead.
 * `connect()` surfaces the wrapped, usage-tracked model as
 * `client.ai.assistant`. Price the meters like any others (`usage:
 * { "assistant.output_tokens": { perUnit: ... } }`), gate them with
 * entitlements, hold them to invariants.
 */
export const metered = <const O extends MeteredOptions = Record<never, never>>(
  model: WrappableModel,
  // `O & MeteredOptions` (not bare `O`): the concrete half keeps editor
  // completions alive inside the literal while `O` captures it
  options?: O & MeteredOptions
): AiMeterConfig<WrappedModel> & Pick<O, Extract<keyof O, "event" | "aggregate">> => {
  const meter: AiMeterConfig<WrappedModel> = {
    kind: "ai",
    ...(options?.event !== undefined ? { event: options.event } : {}),
    ...(options?.aggregate !== undefined ? { aggregate: options.aggregate } : {}),
    ...(options?.unit !== undefined ? { unit: options.unit } : {}),
    bind: (client, event) =>
      wrapLanguageModel({
        model,
        middleware: meteredMiddleware({ ...options, client, event })
      })
  }
  return meter as AiMeterConfig<WrappedModel> &
    Pick<O, Extract<keyof O, "event" | "aggregate">>
}

/** A suggestion-friendly alias kept for aggregate keys in `metered` options. */
export type { AggregateSpec, Suggest }

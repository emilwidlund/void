/**
 * `@void/sdk/ai` — first-class AI usage for the Vercel AI SDK / AI Gateway.
 *
 * Wrap any language model with `metered` and every `generateText` /
 * `streamText` call becomes a usage event on the customer's record, with
 * the cost of serving it attached as `_cost` under the hood. Defaults come
 * from the config's `ai` section, so a call site needs nothing but the
 * customer:
 *
 *   // in defineConfig: ai: { event: "ai.generation", pricing: {...} }
 *   const model = metered(gateway("openai/gpt-4o"), { client: voidClient })
 *
 * Cost resolution, first match wins:
 *   1. the `cost` resolver option (full control, may be async)
 *   2. what the AI Gateway reports for the request (`providerMetadata.gateway`)
 *   3. the `pricing` table (config `ai.pricing`, merged with per-model overrides)
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
import type { TrackOptions, VoidClient } from "./Client.js"
import type {
  AiConfig,
  AiEventProperty,
  Money,
  Suggest,
  TokenPricing
} from "./Config.js"
import { money } from "./Config.js"

export type { AiConfig, AiEventProperty, TokenPricing }

/** What the middleware needs from a void client — `VoidClient` satisfies it. */
export interface TrackClient<EventName extends string = string> {
  track(name: Suggest<EventName>, options?: TrackOptions): PromiseLike<unknown>
  /** config-level AI defaults, carried by clients from `defineConfig().connect()` */
  readonly ai?: AiConfig<EventName>
}

/** The event names a client's config mentions; `string` for untyped clients. */
export type ClientEvents<C> =
  C extends VoidClient<string, string, infer EventName> ? EventName : string

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

export interface MeteredOptions<C extends TrackClient = TrackClient> {
  readonly client: C
  /** event tracked for every call; defaults to the config's `ai.event` */
  readonly event?: Suggest<ClientEvents<C>>
  /** default customer; a function can pull it from request context per call */
  readonly customer?: string | ((info: AiCallInfo) => string | undefined)
  /** extra event properties, merged over the config's `ai.properties` */
  readonly properties?:
    | Readonly<Record<string, string | number | boolean>>
    | ((info: AiCallInfo) => Readonly<Record<string, string | number | boolean>>)
  /** custom cost resolver — takes precedence over gateway metadata and `pricing` */
  readonly cost?: (
    info: AiCallInfo
  ) => Money | undefined | PromiseLike<Money | undefined>
  /** per-model rates merged over the config's `ai.pricing` ("*" as wildcard) */
  readonly pricing?: Readonly<Record<string, TokenPricing>>
  /** tracking failures never break the model call; they land here (default: console.warn) */
  readonly onTrackError?: (error: unknown, info: AiCallInfo) => void
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
 * Typed pricing table for the config's `ai.pricing`: AI Gateway model ids
 * autocomplete, `"*"` is the wildcard, and any other model id string is
 * still accepted (for plain providers whose ids the gateway doesn't know).
 *
 *   ai: { event: "ai.generation", pricing: modelPricing({ "openai/gpt-4o": {...} }) }
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
// AI-event meters are offered in the config
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

/**
 * The middleware itself, for composing with other middlewares via
 * `wrapLanguageModel`. Most callers want `metered` instead.
 */
export const meteredMiddleware = <C extends TrackClient>(
  options: MeteredOptions<C>
): LanguageModelV4Middleware => {
  const defaults = options.client.ai
  const event = options.event ?? defaults?.event
  if (event === undefined) {
    throw new Error(
      "@void/sdk/ai: no event to track — declare `ai: { event }` in defineConfig or pass `event`"
    )
  }
  const pricing =
    defaults?.pricing !== undefined || options.pricing !== undefined
      ? { ...defaults?.pricing, ...options.pricing }
      : undefined

  // per-call overrides survive transformParams via the params object identity
  const perCall = new WeakMap<object, VoidCallOptions>()

  const report = async (call: FinishedCall): Promise<void> => {
    const overrides = perCall.get(call.callOptions)
    if (overrides?.track === false) return
    const info: AiCallInfo = {
      model: call.responseModel ?? call.model.modelId,
      provider: call.model.provider,
      usage: toTokenUsage(call.usage),
      finishReason: call.finishReason,
      streamed: call.streamed,
      durationMs: call.durationMs,
      providerMetadata: call.providerMetadata
    }
    try {
      const cost =
        (options.cost !== undefined ? await options.cost(info) : undefined) ??
        gatewayCost(info.providerMetadata) ??
        tableCost(pricing, info)
      const customer =
        overrides?.customer ??
        (typeof options.customer === "function"
          ? options.customer(info)
          : options.customer)
      const configured =
        typeof options.properties === "function"
          ? options.properties(info)
          : options.properties
      await options.client.track(overrides?.event ?? event, {
        properties: {
          ...autoProperties(info),
          ...defaults?.properties,
          ...configured,
          ...overrides?.properties
        },
        ...(customer !== undefined ? { customer } : {}),
        ...(cost !== undefined ? { cost } : {})
      })
    } catch (error) {
      if (options.onTrackError !== undefined) options.onTrackError(error, info)
      else console.warn("[@void/sdk/ai] failed to track usage event:", error)
    }
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
              if (finish === undefined) return
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

/**
 * Wrap a language model so every call lands on the customer's record:
 *
 *   const model = metered(gateway("openai/gpt-4o"), { client: voidClient })
 *
 * Per-request attribution rides on providerOptions:
 *
 *   await generateText({
 *     model,
 *     prompt,
 *     providerOptions: { void: voidOptions({ customer: "acme" }) },
 *   })
 */
export const metered = <C extends TrackClient>(
  model: WrappableModel,
  options: MeteredOptions<C>
): ReturnType<typeof wrapLanguageModel> =>
  wrapLanguageModel({ model, middleware: meteredMiddleware(options) })

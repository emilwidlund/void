/**
 * The support agent's language model. With an AI Gateway key in the
 * environment this is a real gateway model; without one it falls back to a
 * local simulated model so the demo runs offline. Either way it goes
 * through `metered(...)` in void.ts — the billing integration is identical,
 * which is the point: swap the model, keep the meter.
 */
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { gateway, simulateReadableStream } from "ai"

const CANNED_REPLIES = [
  "I've looked into this — the issue was a stale cache entry. Cleared it; can you retry?",
  "This is a known regression in the last deploy. I've rolled back the config for your workspace.",
  "Your API key had expired scopes. I've re-issued it with the correct permissions.",
  "The webhook endpoint was returning 410 — I've re-registered it and replayed the failed deliveries.",
]

const simulated: LanguageModelV4 = {
  specificationVersion: "v4",
  provider: "simulated",
  modelId: "support-agent",
  supportedUrls: {},
  doGenerate: async ({ prompt }) => {
    const text = CANNED_REPLIES[Math.floor(Math.random() * CANNED_REPLIES.length)]!
    const inputTokens = Math.ceil(JSON.stringify(prompt).length / 4)
    const outputTokens = 120 + Math.floor(Math.random() * 600)
    return {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: {
          total: inputTokens,
          noCache: inputTokens,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
      },
      warnings: [],
    }
  },
  doStream: async (options) => {
    const result = await simulated.doGenerate(options)
    const first = result.content[0]
    const text = first?.type === "text" ? first.text : ""
    const chunks: Array<LanguageModelV4StreamPart> = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: text },
      { type: "text-end", id: "1" },
      { type: "finish", usage: result.usage, finishReason: result.finishReason },
    ]
    return { stream: simulateReadableStream({ chunks }) }
  },
}

export const agentModel = process.env.AI_GATEWAY_API_KEY
  ? gateway("openai/gpt-4o-mini")
  : simulated

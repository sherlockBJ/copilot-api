import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import { limitChatCompletionsPromptImages } from "~/lib/chat-completions-images"
import { state } from "~/lib/state"
import { closeUsageStore } from "~/lib/token-usage"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  ImagePart,
  Message,
} from "~/lib/types/chat-completions"
import type { Model } from "~/lib/types/models"
import { completionRoutes } from "~/routes/chat-completions/route"
import {
  handleWithChatCompletions,
  messagesApiFlowDependencies,
  prepareCopilotChatCompletionsPayload,
} from "~/routes/messages/api-flows"
import { responsesRoutes } from "~/routes/responses/route"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

const makePngDataUrl = (seed: number): string =>
  `data:image/png;base64,${Buffer.from(`img-${seed}`).toString("base64")}`

const makeImagePart = (
  seed: number,
  cacheControl?: ImagePart["cache_control"],
): ImagePart => ({
  type: "image_url",
  image_url: { url: makePngDataUrl(seed) },
  ...(cacheControl ? { cache_control: cacheControl } : {}),
})

const countImageParts = (messages: Array<Message>): Array<string> =>
  messages.flatMap((message) =>
    Array.isArray(message.content) ?
      message.content.flatMap((part: ContentPart) =>
        part.type === "image_url" ? [part.image_url.url] : [],
      )
    : [],
  )

const createGeminiCarbonModel = (maxPromptImages = 10): Model => ({
  capabilities: {
    family: "gemini-4-carbon",
    limits: {
      max_context_window_tokens: 1_000_000,
      max_output_tokens: 64_000,
      max_prompt_tokens: 936_000,
      vision: {
        max_prompt_image_size: 3_145_728,
        max_prompt_images: maxPromptImages,
        supported_media_types: ["image/jpeg", "image/png", "image/webp"],
      },
    },
    object: "model_capabilities",
    supports: {
      parallel_tool_calls: true,
      reasoning_effort: ["low", "medium", "high"],
      streaming: true,
      tool_calls: true,
      vision: maxPromptImages > 0,
    },
    tokenizer: "o200k_base",
    type: "chat",
  },
  id: "gemini-4-carbon",
  model_picker_enabled: true,
  name: "Gemini 4 Carbon",
  object: "model",
  preview: false,
  supported_endpoints: ["/chat/completions"],
  vendor: "Google",
  version: "gemini-4-carbon",
})

const defaultCreateChatCompletions =
  messagesApiFlowDependencies.createChatCompletions
const originalFetch = globalThis.fetch
const originalCopilotToken = state.copilotToken
const originalModels = state.models
const originalVsCodeVersion = state.vsCodeVersion
const originalAccountType = state.accountType

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  state.copilotToken = "test-copilot-token"
  state.vsCodeVersion = "1.100.0"
  state.accountType = "individual"
})

afterEach(async () => {
  messagesApiFlowDependencies.createChatCompletions =
    defaultCreateChatCompletions
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.copilotToken = originalCopilotToken
  state.models = originalModels
  state.vsCodeVersion = originalVsCodeVersion
  state.accountType = originalAccountType
  await closeUsageStore()
})

describe("limitChatCompletionsPromptImages", () => {
  test("leaves payload untouched when limit is absent, invalid, or not exceeded", () => {
    const userMessage: Message = {
      role: "user",
      content: [
        { type: "text", text: "compare" },
        makeImagePart(1),
        makeImagePart(2),
      ],
    }
    const messagesRef = [userMessage]
    const payload: ChatCompletionsPayload = {
      model: "gemini-4-carbon",
      messages: messagesRef,
    }

    expect(limitChatCompletionsPromptImages(payload, undefined)).toBe(0)
    expect(limitChatCompletionsPromptImages(payload, -1)).toBe(0)
    expect(limitChatCompletionsPromptImages(payload, 1.5)).toBe(0)
    expect(limitChatCompletionsPromptImages(payload, 2)).toBe(0)
    expect(payload.messages).toBe(messagesRef)
    expect(payload.messages[0]).toBe(userMessage)
  })

  test("replaces oldest excess images while keeping newest max_prompt_images intact", () => {
    const untouchedRecentMessage: Message = {
      role: "user",
      content: [{ type: "text", text: "latest" }, makeImagePart(12)],
    }
    const originalFirstMessage: Message = {
      role: "user",
      content: [
        { type: "text", text: "early batch" },
        makeImagePart(0, { type: "ephemeral" }),
        makeImagePart(1),
      ],
    }
    const messages: Array<Message> = [
      { role: "system", content: "system prompt" },
      originalFirstMessage,
      ...Array.from(
        { length: 10 },
        (_, idx): Message => ({
          role: "user",
          content: [
            { type: "text", text: `turn ${idx + 2}` },
            makeImagePart(idx + 2),
          ],
        }),
      ),
      untouchedRecentMessage,
    ]
    const payload: ChatCompletionsPayload = {
      model: "gemini-4-carbon",
      messages,
    }

    const omitted = limitChatCompletionsPromptImages(payload, 10)

    expect(omitted).toBe(3)
    expect(countImageParts(payload.messages)).toEqual(
      Array.from({ length: 10 }, (_, idx) => makePngDataUrl(idx + 3)),
    )
    // Original input message array & content were not mutated in place
    expect(countImageParts([originalFirstMessage])).toHaveLength(2)
    expect(payload.messages.at(-1)).toBe(untouchedRecentMessage)

    expect(payload.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "early batch" },
        {
          type: "text",
          text: "[omitted earlier image: model gemini-4-carbon allows at most 10 images per request]",
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: "[omitted earlier image: model gemini-4-carbon allows at most 10 images per request]",
        },
      ],
    })
    expect(payload.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "turn 2" },
        {
          type: "text",
          text: "[omitted earlier image: model gemini-4-carbon allows at most 10 images per request]",
        },
      ],
    })
  })

  test("formats singular and zero-image limit placeholders", () => {
    const singleLimitPayload: ChatCompletionsPayload = {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [makeImagePart(1), makeImagePart(2)],
        },
      ],
    }
    expect(limitChatCompletionsPromptImages(singleLimitPayload, 1)).toBe(1)
    expect(singleLimitPayload.messages[0].content).toEqual([
      {
        type: "text",
        text: "[omitted earlier image: model gpt-4o allows at most 1 image per request]",
      },
      makeImagePart(2),
    ])

    const zeroLimitPayload: ChatCompletionsPayload = {
      model: "text-only-model",
      messages: [
        {
          role: "user",
          content: [makeImagePart(1)],
        },
      ],
    }
    expect(limitChatCompletionsPromptImages(zeroLimitPayload, 0)).toBe(1)
    expect(zeroLimitPayload.messages[0].content).toEqual([
      {
        type: "text",
        text: "[omitted image: model text-only-model does not accept image inputs]",
      },
    ])
  })
})

describe("Chat Completions prompt image limiting across gateway routes", () => {
  test("prepareCopilotChatCompletionsPayload trims excess images and still applies cache markers", () => {
    const model = createGeminiCarbonModel(2)
    const payload: ChatCompletionsPayload = {
      model: "gemini-4-carbon",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: [makeImagePart(1)] },
        { role: "user", content: [makeImagePart(2), makeImagePart(3)] },
      ],
    }

    const omitted = prepareCopilotChatCompletionsPayload(payload, model)

    expect(omitted).toBe(1)
    expect(countImageParts(payload.messages)).toEqual([
      makePngDataUrl(2),
      makePngDataUrl(3),
    ])
    expect(payload.messages[0].copilot_cache_control).toEqual({
      type: "ephemeral",
    })
    expect(payload.messages[2].copilot_cache_control).toEqual({
      type: "ephemeral",
    })
  })

  test("Codex /v1/responses -> Messages fallback -> Chat Completions succeeds with 13 view_image outputs on gemini-4-carbon", async () => {
    state.models = {
      object: "list",
      data: [createGeminiCarbonModel(10)],
    }

    let capturedUpstreamPayload: ChatCompletionsPayload | null = null
    const createChatCompletionsMock = mock(
      (payload: ChatCompletionsPayload): Promise<ChatCompletionResponse> => {
        capturedUpstreamPayload = payload
        return Promise.resolve({
          id: "chatcmpl-gemini",
          object: "chat.completion",
          created: 0,
          model: payload.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Verified latest 10 screenshots",
              },
              logprobs: null,
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 6,
            total_tokens: 126,
          },
        })
      },
    )
    messagesApiFlowDependencies.createChatCompletions =
      createChatCompletionsMock

    const app = new Hono()
    app.route("/v1/responses", responsesRoutes)

    const input: Array<Record<string, unknown>> = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Check screenshots" }],
      },
    ]
    for (let i = 0; i < 13; i++) {
      const callId = `call_img_${i}`
      input.push({
        type: "function_call",
        id: `fc_${i}`,
        call_id: callId,
        name: "view_image",
        arguments: JSON.stringify({ path: `/tmp/shot_${i}.png` }),
      })
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: [{ type: "input_image", image_url: makePngDataUrl(i) }],
      })
    }

    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "codex_cli_rs/0.169.0",
      },
      body: JSON.stringify({
        model: "gemini-4-carbon",
        stream: false,
        input,
      }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { output_text: string }
    expect(body.output_text).toBe("Verified latest 10 screenshots")
    expect(createChatCompletionsMock).toHaveBeenCalledTimes(1)
    expect(capturedUpstreamPayload).not.toBeNull()

    const forwardedImages = countImageParts(capturedUpstreamPayload!.messages)
    expect(forwardedImages).toEqual(
      Array.from({ length: 10 }, (_, idx) => makePngDataUrl(idx + 3)),
    )
    const serializedMessages = JSON.stringify(capturedUpstreamPayload!.messages)
    expect(serializedMessages).toContain("Tool result for call_img_0:")
    expect(serializedMessages).toContain(
      "[omitted earlier image: model gemini-4-carbon allows at most 10 images per request]",
    )
  })

  test("handleWithChatCompletions logs warning when trimming excess images", async () => {
    const warnMock = mock(() => {})
    const logger = {
      debug: () => {},
      warn: warnMock,
      error: () => {},
    } as unknown as Parameters<typeof handleWithChatCompletions>[2]["logger"]

    let capturedPayload: ChatCompletionsPayload | null = null
    messagesApiFlowDependencies.createChatCompletions = mock(
      (payload: ChatCompletionsPayload): Promise<ChatCompletionResponse> => {
        capturedPayload = payload
        return Promise.resolve({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 0,
          model: payload.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              logprobs: null,
              finish_reason: "stop",
            },
          ],
        })
      },
    )

    const response = await handleWithChatCompletions(
      {
        json: (data: unknown) => Response.json(data),
      } as Parameters<typeof handleWithChatCompletions>[0],
      {
        model: "gemini-4-carbon",
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: Buffer.from("img-0").toString("base64"),
                },
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: Buffer.from("img-1").toString("base64"),
                },
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: Buffer.from("img-2").toString("base64"),
                },
              },
            ],
          },
        ],
      },
      {
        logger,
        requestId: "req-1",
        selectedModel: createGeminiCarbonModel(2),
      },
    )

    expect(response.status).toBe(200)
    expect(warnMock).toHaveBeenCalledTimes(1)
    expect(countImageParts(capturedPayload!.messages)).toEqual([
      makePngDataUrl(1),
      makePngDataUrl(2),
    ])
  })

  test("top-level /v1/chat/completions trims excess images before forwarding to Copilot", async () => {
    state.models = {
      object: "list",
      data: [createGeminiCarbonModel(2)],
    }

    const fetchMock = mock(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-direct",
              object: "chat.completion",
              created: 0,
              model: "gemini-4-carbon",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "direct ok" },
                  logprobs: null,
                  finish_reason: "stop",
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          ),
        ),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch

    const app = new Hono()
    app.route("/v1/chat/completions", completionRoutes)

    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-4-carbon",
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "inspect" },
              makeImagePart(1),
              makeImagePart(2),
              makeImagePart(3),
            ],
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    const forwardedBody = JSON.parse((init as RequestInit).body as string) as {
      messages: Array<Message>
    }
    expect(countImageParts(forwardedBody.messages)).toEqual([
      makePngDataUrl(2),
      makePngDataUrl(3),
    ])
    expect(
      (init as RequestInit & { headers: Record<string, string> }).headers[
        "copilot-vision-request"
      ],
    ).toBe("true")
  })
})

import { describe, expect, test } from "bun:test"

import type { ResponseInputItem } from "~/lib/types/responses"
import { translateToOpenAI } from "~/routes/messages/completions-translation"
import { translateResponsesToMessages } from "~/routes/responses/messages-translation"

const standaloneOutput = (overrides: Record<string, unknown> = {}) => ({
  type: "function_call_output",
  namespace: "agent",
  name: "codex_apps_open_page",
  output: '{"page_id":null}',
  ...overrides,
})

const translate = (input: Array<ResponseInputItem>) =>
  translateResponsesToMessages(
    { model: "gemini-test", input },
    { model: "gemini-test" },
  ).messagesPayload

describe("Codex standalone function_call_output items", () => {
  test("preserves Codex /goal agent.goal_objective output without call_id as user context", () => {
    const result = translate([
      { type: "message", role: "developer", content: "Base instructions" },
      {
        type: "message",
        role: "user",
        content:
          '<codex_internal_context source="user_goal">\nUser set goal status: "active".\n</codex_internal_context>',
      },
      standaloneOutput({
        id: "fco_goal_1",
        name: "goal_objective",
        output: "Complete persistent Goal closure across desktop and CLI.",
      }),
      {
        type: "message",
        role: "user",
        content: "Continue working toward the active thread goal.",
      },
    ])

    expect(result.messages).toEqual([
      {
        role: "user",
        content:
          '<codex_internal_context source="user_goal">\nUser set goal status: "active".\n</codex_internal_context>',
      },
      {
        role: "user",
        content: [
          { type: "text", text: "agent.goal_objective:" },
          {
            type: "text",
            text: "Complete persistent Goal closure across desktop and CLI.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Continue working toward the active thread goal.",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ])
    const completions = translateToOpenAI(result)
    expect(
      completions.messages.some((message) => message.role === "tool"),
    ).toBe(false)
    expect(JSON.stringify(completions.messages)).toContain(
      "agent.goal_objective:",
    )
  })

  test("preserves open and multipart selected page snapshots as user context", () => {
    const result = translate([
      { type: "message", role: "developer", content: "Base instructions" },
      standaloneOutput(),
      standaloneOutput({
        name: "codex_apps_selected_page_part_1_of_2",
        output: "Companion Page snapshot part 1 of 2:\nFirst part",
      }),
      standaloneOutput({
        name: "codex_apps_selected_page_part_2_of_2",
        output: "Companion Page snapshot part 2 of 2:\nSecond part",
      }),
      { type: "message", role: "user", content: "hi" },
    ])

    expect(result.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "agent.codex_apps_open_page:" },
          { type: "text", text: '{"page_id":null}' },
          {
            type: "text",
            text: "agent.codex_apps_selected_page_part_1_of_2:",
          },
          {
            type: "text",
            text: "Companion Page snapshot part 1 of 2:\nFirst part",
          },
          {
            type: "text",
            text: "agent.codex_apps_selected_page_part_2_of_2:",
          },
          {
            type: "text",
            text: "Companion Page snapshot part 2 of 2:\nSecond part",
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
        ],
      },
    ])
    expect(JSON.stringify(result.system)).not.toContain("page_id")
    const completions = translateToOpenAI(result)
    expect(
      completions.messages.some((message) => message.role === "tool"),
    ).toBe(false)
    expect(JSON.stringify(completions.messages)).toContain("First part")
    expect(JSON.stringify(completions.messages)).toContain("Second part")
  })

  test.each([
    {
      namespace: "agent",
      name: "goal_objective",
      output: "Deliver clean PR #2",
    },
    {
      namespace: "codex_app",
      name: "send_message_to_thread",
      output:
        "<codex_delegation>\n  <source_thread_id>t-1</source_thread_id>\n  <input>Verify host</input>\n</codex_delegation>",
    },
    {
      namespace: "codex_app",
      name: "create_thread",
      output: "<codex_delegation><input>Init</input></codex_delegation>",
    },
    {
      namespace: "codex_app",
      name: "handoff_thread",
      output: "<codex_delegation><input>Handoff</input></codex_delegation>",
    },
    {
      namespace: "cloud_threads",
      name: "send_message",
      output: "<codex_delegation><input>Cloud</input></codex_delegation>",
    },
    {
      namespace: "agent",
      name: "ide_context",
      output: "Active file: src/main.ts",
    },
    {
      namespace: "slack",
      name: "notifications",
      output: "Alice mentioned you.",
    },
  ])(
    "preserves injected $namespace.$name outputs without call IDs",
    ({ namespace, name, output }) => {
      const result = translate([standaloneOutput({ namespace, name, output })])
      expect(result.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: `${namespace}.${name}:` },
            {
              type: "text",
              text: output,
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ])
    },
  )

  test.each([
    { namespace: "agent", name: "goal_objective" },
    { namespace: "agent", name: "codex_apps_open_page" },
    { namespace: "codex_app", name: "create_thread" },
    { namespace: "codex_app", name: "send_message_to_thread" },
    { namespace: "cloud_threads", name: "send_message" },
  ])(
    "treats $namespace.$name context as a user boundary for developer updates",
    (identity) => {
      const result = translate([
        { type: "message", role: "developer", content: "Initial instructions" },
        standaloneOutput(identity),
        {
          type: "message",
          role: "developer",
          content: "Mid-conversation developer instructions",
        },
        { type: "message", role: "user", content: "hi" },
      ])
      expect(JSON.stringify(result.system)).not.toContain(
        "Mid-conversation developer instructions",
      )
      expect(JSON.stringify(result.messages)).toContain(
        "Mid-conversation developer instructions",
      )
    },
  )

  test("skips historical web_search_call items when switching a GPT thread to Messages", () => {
    const result = translate([
      { type: "message", role: "user", content: "Look up PR 500" },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Searching" }],
        encrypted_content: "enc-1",
      },
      {
        type: "web_search_call",
        id: "ws-1",
        status: "completed",
        action: { type: "open_page", url: "https://example.com" },
      },
      { type: "message", role: "assistant", content: "Checked PR 500" },
      standaloneOutput({
        namespace: "agent",
        name: "goal_objective",
        output: "Continue goal execution",
      }),
    ])
    expect(result.messages).toHaveLength(3)
    expect(result.messages[1].role).toBe("assistant")
    expect(result.messages[2].role).toBe("user")
  })

  test("preserves array content and images while omitting empty text blocks", () => {
    const result = translate([
      standaloneOutput({
        call_id: null,
        output: [
          { type: "input_text", text: "" },
          { type: "input_text", text: "Selected content" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
        ],
      }),
      { type: "message", role: "user", content: "Describe it" },
    ])
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "agent.codex_apps_open_page:" },
      { type: "text", text: "Selected content" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
      },
    ])
  })

  test.each(
    ["", null, undefined, [], [{ type: "input_text", text: "" }]].map(
      (output) => ({ output }),
    ),
  )(
    "accepts empty context output %j without creating empty text blocks",
    ({ output }) => {
      const result = translate([standaloneOutput({ output })])
      expect(result.messages[0].content).toEqual([
        {
          type: "text",
          text: "agent.codex_apps_open_page:",
          cache_control: { type: "ephemeral" },
        },
      ])
    },
  )

  test.each([
    { name: undefined },
    { name: null },
    { name: "" },
    { name: " " },
    { name: 123 },
    { namespace: undefined },
    { namespace: null },
    { namespace: "" },
    { namespace: " " },
    { namespace: 123 },
    { type: "custom_tool_call_output" },
    { call_id: "" },
    { call_id: 123 },
  ])("rejects malformed ordinary tool results %j", (overrides) => {
    expect(() => translate([standaloneOutput(overrides)])).toThrow(
      `${overrides.type ?? "function_call_output"}.call_id is required`,
    )
  })

  test("keeps results with call IDs linked to real tool calls", () => {
    const result = translate([
      {
        type: "function_call",
        namespace: "agent",
        name: "codex_apps_open_page",
        call_id: "call-page",
        arguments: "{}",
      },
      standaloneOutput({ call_id: "call-page" }),
    ])
    expect(result.messages[1].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "call-page",
        content: '{"page_id":null}',
        is_error: false,
        cache_control: { type: "ephemeral" },
      },
    ])
  })

  test("still validates injected output content", () => {
    expect(() => translate([standaloneOutput({ output: 123 })])).toThrow(
      "function_call_output.output must be text or an array",
    )
  })
})

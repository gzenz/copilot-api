import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import { state } from "../src/lib/state"
import { responsesRoutes } from "../src/routes/responses/route"

const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  lastRequestTimestamp: state.lastRequestTimestamp,
  manualApprove: state.manualApprove,
  models: state.models,
  rateLimitSeconds: state.rateLimitSeconds,
  rateLimitWait: state.rateLimitWait,
  verbose: state.verbose,
  vsCodeVersion: state.vsCodeVersion,
}

const createModels = () => ({
  object: "list" as const,
  data: [
    {
      capabilities: {
        family: "gpt-5-mini",
        limits: {
          max_prompt_tokens: 128000,
        },
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: "gpt-5-mini",
      model_picker_enabled: true,
      name: "GPT-5 mini",
      object: "model" as const,
      preview: false,
      supported_endpoints: ["/responses"],
      vendor: "OpenAI",
      version: "gpt-5-mini",
    },
    {
      capabilities: {
        family: "gpt-5.2",
        limits: {
          max_prompt_tokens: 272000,
        },
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: "gpt-5.2",
      model_picker_enabled: true,
      name: "GPT-5.2",
      object: "model" as const,
      preview: false,
      supported_endpoints: ["/responses"],
      vendor: "OpenAI",
      version: "gpt-5.2",
    },
    {
      capabilities: {
        family: "gpt-5.5",
        limits: {
          max_prompt_tokens: 272000,
        },
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: "gpt-5.5",
      model_picker_enabled: true,
      name: "GPT-5.5",
      object: "model" as const,
      preview: false,
      supported_endpoints: ["/responses"],
      vendor: "OpenAI",
      version: "gpt-5.5",
    },
  ],
})

const createApp = () => {
  const app = new Hono()
  app.route("/v1/responses", responsesRoutes)
  return app
}

beforeEach(() => {
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.manualApprove = false
  state.verbose = false
  state.vsCodeVersion = "1.0.0"
  state.rateLimitWait = false
  state.rateLimitSeconds = undefined
  state.lastRequestTimestamp = undefined
  state.models = createModels()
})

afterEach(() => {
  state.accountType = originalState.accountType
  state.copilotToken = originalState.copilotToken
  state.manualApprove = originalState.manualApprove
  state.verbose = originalState.verbose
  state.vsCodeVersion = originalState.vsCodeVersion
  state.rateLimitWait = originalState.rateLimitWait
  state.rateLimitSeconds = originalState.rateLimitSeconds
  state.lastRequestTimestamp = originalState.lastRequestTimestamp
  state.models = originalState.models
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

describe("responses handler", () => {
  test.each([
    ["guardian_subagent", "gpt-5-mini"],
    ["codex-auto-review", "gpt-5.2"],
  ])(
    "maps Codex approval reviewer model alias %s to %s",
    async (modelAlias, expectedModel) => {
      const fetchMock = mock(
        (_url: string | URL | Request, init?: RequestInit) => {
          const requestBody = typeof init?.body === "string" ? init.body : "{}"
          const upstreamPayload = JSON.parse(requestBody) as { model: string }

          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "resp-test",
                object: "response",
                created_at: 0,
                model: upstreamPayload.model,
                output: [],
                output_text: "",
                status: "completed",
                error: null,
                incomplete_details: null,
                instructions: null,
                metadata: null,
                parallel_tool_calls: true,
                temperature: 1,
                tool_choice: "auto",
                tools: [],
                top_p: null,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          )
        },
      )
      ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
        fetchMock as unknown as typeof fetch

      const response = await createApp().request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: modelAlias,
          input: "Review this permission request.",
          max_output_tokens: 64,
          stream: false,
          store: false,
        }),
      })

      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const calls = fetchMock.mock.calls as unknown as Array<
        [string | URL | Request, RequestInit]
      >
      const requestBody =
        typeof calls[0][1].body === "string" ? calls[0][1].body : "{}"
      const upstreamPayload = JSON.parse(requestBody) as {
        model: string
      }
      expect(upstreamPayload.model).toBe(expectedModel)
    },
  )

  test("recovers Copilot cyber policy failures as a model-visible response", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              message: `${JSON.stringify({
                error: {
                  message:
                    "This content was flagged for possible cybersecurity risk.",
                  code: "cyber_policy",
                },
              })}\n`,
              type: "error",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      ),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch

    const response = await createApp().request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "Review this request.",
        max_output_tokens: 64,
        stream: false,
        store: false,
      }),
    })

    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      error: null
      output_text: string
      status: string
    }
    expect(body.error).toBeNull()
    expect(body.status).toBe("completed")
    expect(body.output_text).toContain("wording triggered a safety filter")
    expect(body.output_text).toContain("Rephrase your next attempt")
    expect(body.output_text).toContain("ask the user for clarification")
    expect(body.output_text).not.toContain("cybersecurity risk")
  })

  test("streams recovered Copilot cyber policy failures as completed response events", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              message: `${JSON.stringify({
                error: {
                  message:
                    "This content was flagged for possible cybersecurity risk.",
                  code: "cyber_policy",
                },
              })}\n`,
              type: "error",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      ),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch

    const response = await createApp().request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "Review this request.",
        max_output_tokens: 64,
        stream: true,
        store: false,
      }),
    })

    expect(response.status).toBe(200)

    const body = await response.text()
    expect(body).toContain("event: response.completed")
    expect(body).toContain("Rephrase your next attempt")
    expect(body).not.toContain("cybersecurity risk")
  })

  test("keeps Copilot cyber policy failures as errors for non-gpt-5.5 models", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              message: `${JSON.stringify({
                error: {
                  message:
                    "This content was flagged for possible cybersecurity risk.",
                  code: "cyber_policy",
                },
              })}\n`,
              type: "error",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      ),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch

    const response = await createApp().request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-mini",
        input: "Review this request.",
        max_output_tokens: 64,
        stream: false,
        store: false,
      }),
    })

    expect(response.status).toBe(400)

    const body = (await response.json()) as {
      error: {
        message: string
        type: string
      }
    }
    expect(body.error.type).toBe("error")
    expect(body.error.message).toContain("cyber_policy")
  })
})

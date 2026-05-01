import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import { state } from "../src/lib/state"
import { responsesRoutes } from "../src/routes/responses/route"

const originalFetch = globalThis.fetch
const originalOpenAIKey = process.env.OPENAI_API_KEY
const originalModels = state.models

const createModels = () => ({
  object: "list" as const,
  data: [
    {
      capabilities: {
        family: "gpt-5.5",
        limits: {
          max_context_window_tokens: 400000,
          max_output_tokens: 128000,
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
      vendor: "OpenAI",
      version: "gpt-5.5",
      supported_endpoints: ["/responses"],
    },
  ],
})

const createApp = () => {
  const app = new Hono()
  app.route("/v1/responses", responsesRoutes)
  return app
}

beforeEach(() => {
  state.models = createModels()
})

afterEach(() => {
  state.models = originalModels
  process.env.OPENAI_API_KEY = originalOpenAIKey
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

describe("responses input token counting", () => {
  test("forwards GPT-family counts to OpenAI when OPENAI_API_KEY is configured", async () => {
    process.env.OPENAI_API_KEY = "sk-test"
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: "response.input_tokens",
            input_tokens: 123,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch

    const response = await createApp().request("/v1/responses/input_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", input: "hello" }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      object: "response.input_tokens",
      input_tokens: 123,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const calls = fetchMock.mock.calls as unknown as Array<Array<unknown>>
    expect(calls[0][0]).toBe("https://api.openai.com/v1/responses/input_tokens")
  })

  test("falls back to local tokenizer estimate without OPENAI_API_KEY", async () => {
    delete process.env.OPENAI_API_KEY

    const response = await createApp().request("/v1/responses/input_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", input: "hello" }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      object: string
      input_tokens: number
    }
    expect(body.object).toBe("response.input_tokens")
    expect(body.input_tokens).toBeGreaterThan(0)
  })
})

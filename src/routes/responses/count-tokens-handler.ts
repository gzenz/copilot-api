import type { Context } from "hono"

import consola from "consola"

import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool as ChatTool,
} from "~/services/copilot/create-chat-completions"
import type {
  FunctionTool,
  ResponseInputContent,
  ResponseInputItem,
  ResponseInputMessage,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

import { getOpenAIApiKey } from "~/lib/config"
import { findEndpointModel } from "~/lib/models"
import { getTokenCount } from "~/lib/tokenizer"

const isOpenAIModel = (model: string): boolean =>
  model.startsWith("gpt") || model.startsWith("o")

const countTokensViaOpenAI = async (
  c: Context,
  payload: ResponsesPayload,
): Promise<Response | null> => {
  if (!isOpenAIModel(payload.model)) return null

  const apiKey = getOpenAIApiKey()
  if (!apiKey) return null

  const res = await fetch("https://api.openai.com/v1/responses/input_tokens", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    consola.warn(
      "OpenAI responses/input_tokens failed:",
      res.status,
      await res.text().catch(() => ""),
      "- falling back to estimation",
    )
    return null
  }

  const result = (await res.json()) as { input_tokens: number }
  consola.info("Responses token count (OpenAI API):", result.input_tokens)
  return c.json({
    object: "response.input_tokens",
    input_tokens: result.input_tokens,
  })
}

const contentToText = (
  content: string | Array<ResponseInputContent> | undefined,
): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if ("text" in part && typeof part.text === "string") return part.text
      return JSON.stringify(part)
    })
    .join("\n")
}

const inputItemToMessage = (item: ResponseInputItem): Message | null => {
  if (!("role" in item) || typeof item.role !== "string") return null
  const role = item.role
  if (!["assistant", "developer", "system", "user"].includes(role)) return null
  return {
    role: role as ResponseInputMessage["role"],
    content: contentToText((item as ResponseInputMessage).content) as
      | string
      | Array<ContentPart>,
  }
}

const responsesToChatPayload = (
  payload: ResponsesPayload,
): ChatCompletionsPayload => {
  const messages: Array<Message> = []
  if (payload.instructions) {
    messages.push({ role: "developer", content: payload.instructions })
  }
  if (typeof payload.input === "string") {
    messages.push({ role: "user", content: payload.input })
  } else if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      const message = inputItemToMessage(item)
      if (message) messages.push(message)
    }
  }

  const tools = (payload.tools ?? [])
    .filter(
      (tool): tool is FunctionTool =>
        tool.type === "function" && "name" in tool,
    )
    .map(
      (tool): ChatTool => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description ?? undefined,
          parameters: tool.parameters ?? {},
        },
      }),
    )

  return {
    model: payload.model,
    messages,
    tools: tools.length > 0 ? tools : undefined,
  }
}

export async function handleResponsesInputTokens(c: Context) {
  try {
    const payload = await c.req.json<ResponsesPayload>()

    const openAIResult = await countTokensViaOpenAI(c, payload)
    if (openAIResult) return openAIResult

    const selectedModel = findEndpointModel(payload.model)
    if (!selectedModel) {
      consola.warn(
        "Model not found, returning default responses input token count",
      )
      return c.json({ object: "response.input_tokens", input_tokens: 1 })
    }

    const tokenCount = await getTokenCount(
      responsesToChatPayload(payload),
      selectedModel,
    )
    consola.info("Responses token count:", tokenCount.input)
    return c.json({
      object: "response.input_tokens",
      input_tokens: tokenCount.input,
    })
  } catch (error) {
    consola.error("Error counting Responses input tokens:", error)
    return c.json({ object: "response.input_tokens", input_tokens: 1 })
  }
}

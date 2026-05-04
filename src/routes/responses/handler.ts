import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import {
  getConfig,
  isCyberPolicyErrorRecoveryEnabled,
  isResponsesApiWebSearchEnabled,
  resolveModelAlias,
} from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger, debugJson, debugJsonTail } from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { generateRequestIdFromPayload, getUUID } from "~/lib/utils"
import {
  createResponses,
  type ResponsesPayload,
  type ResponsesResult,
} from "~/services/copilot/create-responses"

import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesRequestOptions,
} from "./utils"

const logger = createHandlerLogger("responses-handler")

const RESPONSES_ENDPOINT = "/responses"

export const handleResponses = async (c: Context) => {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  const requestedModel = payload.model
  payload.model = resolveModelAlias(payload.model)
  if (payload.model !== requestedModel) {
    logger.debug("Resolved model alias:", {
      requestedModel,
      resolvedModel: payload.model,
    })
  }
  debugJson(logger, "Responses request payload:", payload)

  // not support subagent marker for now , set sessionId = getUUID(requestId)
  const requestId = generateRequestIdFromPayload({ messages: payload.input })
  logger.debug("Generated request ID:", requestId)

  const sessionId = getUUID(requestId)
  logger.debug("Extracted session ID:", sessionId)

  useFunctionApplyPatch(payload)

  removeUnsupportedTools(payload)

  if (!isResponsesApiWebSearchEnabled()) {
    removeWebSearchTool(payload)
  }

  compactInputByLatestCompaction(payload)

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const supportsResponses =
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false

  if (!supportsResponses) {
    return c.json(
      {
        error: {
          message:
            "This model does not support the responses endpoint. Please choose a different model.",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  applyResponsesApiContextManagement(
    payload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )

  debugJson(logger, "Translated Responses payload:", payload)

  const { vision, initiator } = getResponsesRequestOptions(payload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createResponsesWithCyberPolicyRecovery(c, payload, {
    vision,
    initiator,
    requestId,
    sessionId: sessionId,
  })

  if (response instanceof Response) {
    return response
  }

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    logger.debug("Forwarding native Responses stream")
    return streamSSE(c, async (stream) => {
      const idTracker = createStreamIdTracker()

      for await (const chunk of response) {
        debugJson(logger, "Responses stream chunk:", chunk)

        const processedData = fixStreamIds(
          (chunk as { data?: string }).data ?? "",
          (chunk as { event?: string }).event,
          idTracker,
        )

        await stream.writeSSE({
          id: (chunk as { id?: string }).id,
          event: (chunk as { event?: string }).event,
          data: processedData,
        })
      }
    })
  }

  debugJsonTail(logger, "Forwarding native Responses result:", {
    value: response,
    tailLength: 400,
  })
  return c.json(response as ResponsesResult)
}

type ResponsesRequestOptions = Parameters<typeof createResponses>[1]

const createResponsesWithCyberPolicyRecovery = async (
  c: Context,
  payload: ResponsesPayload,
  options: ResponsesRequestOptions,
): Promise<Awaited<ReturnType<typeof createResponses>> | Response> => {
  try {
    return await createResponses(payload, options)
  } catch (error) {
    const policyError = await extractCyberPolicyError(error)
    if (
      !policyError
      || !isCyberPolicyErrorRecoveryEnabled()
      || !shouldRecoverCyberPolicyError(payload.model)
    ) {
      throw error
    }

    logger.warn("Recovered Copilot cyber policy error as assistant response", {
      message: policyError.message,
    })

    const response = createCyberPolicyRecoveryResponse(payload)
    if (isStreamingRequested(payload)) {
      return streamCyberPolicyRecoveryResponse(c, response)
    }
    return c.json(response)
  }
}

interface CyberPolicyError {
  message: string
}

const shouldRecoverCyberPolicyError = (model: string): boolean =>
  model === "gpt-5.5" || model.startsWith("gpt-5.5-")

const extractCyberPolicyError = async (
  error: unknown,
): Promise<CyberPolicyError | null> => {
  if (!(error instanceof HTTPError)) {
    return null
  }

  const errorText = await error.response.clone().text()
  const parsedError = parseJsonIfPossible(errorText)
  const flattened = flattenErrorPayload(parsedError)
  const hasCyberPolicyCode = flattened.some(
    (entry) => entry.key === "code" && entry.value === "cyber_policy",
  )

  if (!hasCyberPolicyCode) {
    return null
  }

  const message = flattened.find(
    (entry) => entry.key === "message" && entry.value.trim(),
  )?.value

  return {
    message:
      message ?? "This content was flagged for possible cybersecurity risk.",
  }
}

interface FlattenedErrorEntry {
  key: string
  value: string
}

const flattenErrorPayload = (
  value: unknown,
  key = "",
  depth = 0,
): Array<FlattenedErrorEntry> => {
  if (depth > 6) {
    return []
  }

  if (typeof value === "string") {
    const parsed = parseJsonIfPossible(value)
    if (parsed !== value) {
      return flattenErrorPayload(parsed, key, depth + 1)
    }
    return key ? [{ key, value }] : []
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenErrorPayload(item, key, depth + 1))
  }

  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([entryKey, entryValue]) =>
      flattenErrorPayload(entryValue, entryKey, depth + 1),
    )
  }

  return []
}

const parseJsonIfPossible = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const createCyberPolicyRecoveryResponse = (
  payload: ResponsesPayload,
): ResponsesResult => {
  const createdAt = Math.floor(Date.now() / 1000)
  const responseId = `resp_cyber_policy_${getUUID(String(createdAt))}`
  const messageId = `msg_cyber_policy_${getUUID(responseId)}`
  const text = [
    "The upstream model rejected the agent-generated request because its wording triggered a safety filter.",
    "Rephrase your next attempt around the benign operational goal, authorized scope, and expected outcome. Do not keep retrying the same wording. If the safe scope is unclear, ask the user for clarification; otherwise continue with the workflow using clearer wording.",
  ].join("\n\n")

  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    model: payload.model,
    output: [
      {
        id: messageId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text,
            annotations: [],
          },
        ],
      },
    ],
    output_text: text,
    status: "completed",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
    error: null,
    incomplete_details: null,
    instructions: payload.instructions ?? null,
    metadata: payload.metadata ?? null,
    parallel_tool_calls: Boolean(payload.parallel_tool_calls),
    temperature: payload.temperature ?? null,
    tool_choice: payload.tool_choice ?? "auto",
    tools: payload.tools ?? [],
    top_p: payload.top_p ?? null,
  }
}

const streamCyberPolicyRecoveryResponse = (
  c: Context,
  response: ResponsesResult,
): Response =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: "response.created",
      data: JSON.stringify({
        type: "response.created",
        sequence_number: 0,
        response,
      }),
    })
    await stream.writeSSE({
      event: "response.output_item.added",
      data: JSON.stringify({
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: response.output[0],
      }),
    })
    await stream.writeSSE({
      event: "response.output_text.delta",
      data: JSON.stringify({
        type: "response.output_text.delta",
        sequence_number: 2,
        output_index: 0,
        content_index: 0,
        item_id: response.output[0]?.id,
        delta: response.output_text,
      }),
    })
    await stream.writeSSE({
      event: "response.output_text.done",
      data: JSON.stringify({
        type: "response.output_text.done",
        sequence_number: 3,
        output_index: 0,
        content_index: 0,
        item_id: response.output[0]?.id,
        text: response.output_text,
      }),
    })
    await stream.writeSSE({
      event: "response.output_item.done",
      data: JSON.stringify({
        type: "response.output_item.done",
        sequence_number: 4,
        output_index: 0,
        item: response.output[0],
      }),
    })
    await stream.writeSSE({
      event: "response.completed",
      data: JSON.stringify({
        type: "response.completed",
        sequence_number: 5,
        response,
      }),
    })
  })

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

const useFunctionApplyPatch = (payload: ResponsesPayload): void => {
  let shouldUseFunctionApplyPatch = true
  try {
    shouldUseFunctionApplyPatch = getConfig().useFunctionApplyPatch ?? true
  } catch (error) {
    logger.warn("Failed to read useFunctionApplyPatch config", error)
  }

  if (shouldUseFunctionApplyPatch) {
    logger.debug("Using function tool apply_patch for responses")
    if (Array.isArray(payload.tools)) {
      const toolsArr = payload.tools
      for (let i = 0; i < toolsArr.length; i++) {
        const t = toolsArr[i]
        if (t.type === "custom" && t.name === "apply_patch") {
          toolsArr[i] = {
            type: "function",
            name: t.name,
            description: "Use the `apply_patch` tool to edit files",
            parameters: {
              type: "object",
              properties: {
                input: {
                  type: "string",
                  description: "The entire contents of the apply_patch command",
                },
              },
              required: ["input"],
            },
            strict: false,
          }
        }
      }
    }
  }
}

const removeWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((t) => {
    return t.type !== "web_search"
  })
}

const COPILOT_UNSUPPORTED_TOOL_TYPES = new Set(["image_generation"])

export const removeUnsupportedTools = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  const dropped: Array<string> = []
  payload.tools = payload.tools.filter((t) => {
    const type = t.type as string
    if (COPILOT_UNSUPPORTED_TOOL_TYPES.has(type)) {
      dropped.push(type)
      return false
    }
    return true
  })
  if (dropped.length > 0) {
    logger.debug("Removed unsupported tools:", dropped)
  }
}

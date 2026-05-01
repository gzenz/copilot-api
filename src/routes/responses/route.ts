import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleResponsesInputTokens } from "./count-tokens-handler"
import { handleResponses } from "./handler"

export const responsesRoutes = new Hono()

responsesRoutes.post("/", async (c) => {
  try {
    return await handleResponses(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})

responsesRoutes.post("/input_tokens", async (c) => {
  try {
    return await handleResponsesInputTokens(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})

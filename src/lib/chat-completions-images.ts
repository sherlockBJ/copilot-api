import type {
  ChatCompletionsPayload,
  ContentPart,
  ImagePart,
  TextPart,
} from "~/lib/types/chat-completions"

interface ImagePartLocation {
  content: Array<ContentPart>
  messageIndex: number
  partIndex: number
  part: ImagePart
}

/**
 * Enforces Copilot Chat Completions per-model `max_prompt_images` limits by
 * replacing the oldest excess `image_url` parts with text placeholders while
 * keeping the most recent images intact.
 */
export const limitChatCompletionsPromptImages = (
  payload: ChatCompletionsPayload,
  maxPromptImages?: number,
): number => {
  if (
    typeof maxPromptImages !== "number"
    || !Number.isInteger(maxPromptImages)
    || maxPromptImages < 0
    || !Array.isArray(payload.messages)
  ) {
    return 0
  }

  const imageLocations = collectImagePartLocations(payload)
  const excessCount = imageLocations.length - maxPromptImages
  if (excessCount <= 0) {
    return 0
  }

  const nextMessages = [...payload.messages]
  const clonedContents = new Map<number, Array<ContentPart>>()

  for (let i = 0; i < excessCount; i++) {
    const { content, messageIndex, partIndex, part } = imageLocations[i]
    const currentMessage = nextMessages[messageIndex]
    let nextContent = clonedContents.get(messageIndex)
    if (!nextContent) {
      nextContent = [...content]
      nextMessages[messageIndex] = {
        ...currentMessage,
        content: nextContent,
      }
      clonedContents.set(messageIndex, nextContent)
    }

    nextContent[partIndex] = createOmittedPromptImagePart(
      part,
      payload.model,
      maxPromptImages,
    )
  }

  payload.messages = nextMessages
  return excessCount
}

const collectImagePartLocations = (
  payload: ChatCompletionsPayload,
): Array<ImagePartLocation> => {
  const locations: Array<ImagePartLocation> = []

  for (const [messageIndex, message] of payload.messages.entries()) {
    if (!Array.isArray(message.content)) {
      continue
    }

    const content = message.content
    for (const [partIndex, part] of content.entries()) {
      if (isImageContentPart(part)) {
        locations.push({ content, messageIndex, partIndex, part })
      }
    }
  }

  return locations
}

const isImageContentPart = (part: ContentPart): part is ImagePart =>
  typeof part === "object" && part !== null && part.type === "image_url"

const createOmittedPromptImagePart = (
  part: ImagePart,
  model: string,
  maxPromptImages: number,
): TextPart => ({
  type: "text",
  text:
    maxPromptImages === 0 ?
      `[omitted image: model ${model} does not accept image inputs]`
    : `[omitted earlier image: model ${model} allows at most ${maxPromptImages} image${maxPromptImages === 1 ? "" : "s"} per request]`,
  ...(part.cache_control ? { cache_control: part.cache_control } : {}),
})

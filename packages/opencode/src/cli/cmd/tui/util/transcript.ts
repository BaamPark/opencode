import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util/locale"

export type TranscriptOptions = {
  thinking: boolean
  toolDetails: boolean
  assistantMetadata: boolean
}

export type SessionInfo = {
  id: string
  title: string
  time: {
    created: number
    updated: number
  }
}

export type MessageWithParts = {
  info: UserMessage | AssistantMessage
  parts: Part[]
}

export function formatTranscript(
  session: SessionInfo,
  messages: MessageWithParts[],
  options: TranscriptOptions,
): string {
  let transcript = `# ${session.title}\n\n`
  transcript += `**Session ID:** ${session.id}\n`
  transcript += `**Created:** ${new Date(session.time.created).toLocaleString()}\n`
  transcript += `**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n`
  const totals = messages.reduce(
    (acc, msg) => {
      if (msg.info.role !== "assistant") return acc
      const cost = msg.info.cost ?? 0
      const tokens = msg.info.tokens
      acc.cost += cost
      if (tokens) {
        acc.tokens.input += tokens.input ?? 0
        acc.tokens.output += tokens.output ?? 0
        acc.tokens.reasoning += tokens.reasoning ?? 0
        acc.tokens.cache.read += tokens.cache?.read ?? 0
        acc.tokens.cache.write += tokens.cache?.write ?? 0
      }
      return acc
    },
    {
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  )
  const totalTokens =
    totals.tokens.input +
    totals.tokens.output +
    totals.tokens.reasoning +
    totals.tokens.cache.read +
    totals.tokens.cache.write
  transcript += `**Total Tokens:** ${totalTokens.toLocaleString()}`
  transcript += ` (input ${totals.tokens.input.toLocaleString()}, output ${totals.tokens.output.toLocaleString()}, reasoning ${totals.tokens.reasoning.toLocaleString()}, cache read ${totals.tokens.cache.read.toLocaleString()}, cache write ${totals.tokens.cache.write.toLocaleString()})\n`
  transcript += `**Total Cost:** $${totals.cost.toFixed(4)}\n\n`
  transcript += `---\n\n`

  for (const msg of messages) {
    transcript += formatMessage(msg.info, msg.parts, options)
    transcript += `---\n\n`
  }

  return transcript
}

export function formatMessage(msg: UserMessage | AssistantMessage, parts: Part[], options: TranscriptOptions): string {
  let result = ""

  if (msg.role === "user") {
    result += `## User\n\n`
  } else {
    result += formatAssistantHeader(msg, options.assistantMetadata)
  }

  for (const part of parts) {
    result += formatPart(part, options)
  }

  return result
}

export function formatAssistantHeader(msg: AssistantMessage, includeMetadata: boolean): string {
  if (!includeMetadata) {
    return `## Assistant\n\n`
  }

  const duration =
    msg.time.completed && msg.time.created ? ((msg.time.completed - msg.time.created) / 1000).toFixed(1) + "s" : ""

  return `## Assistant (${Locale.titlecase(msg.agent)} · ${msg.modelID}${duration ? ` · ${duration}` : ""})\n\n`
}

export function formatPart(part: Part, options: TranscriptOptions): string {
  if (part.type === "text" && !part.synthetic) {
    return `${part.text}\n\n`
  }

  if (part.type === "reasoning") {
    if (options.thinking) {
      return `_Thinking:_\n\n${part.text}\n\n`
    }
    return ""
  }

  if (part.type === "tool") {
    let result = `\`\`\`\nTool: ${part.tool}\n`
    if (options.toolDetails && part.state.input) {
      result += `\n**Input:**\n\`\`\`json\n${JSON.stringify(part.state.input, null, 2)}\n\`\`\``
    }
    if (options.toolDetails && part.state.status === "completed" && part.state.output) {
      result += `\n**Output:**\n\`\`\`\n${part.state.output}\n\`\`\``
    }
    if (options.toolDetails && part.state.status === "error" && part.state.error) {
      result += `\n**Error:**\n\`\`\`\n${part.state.error}\n\`\`\``
    }
    result += `\n\`\`\`\n\n`
    return result
  }

  return ""
}

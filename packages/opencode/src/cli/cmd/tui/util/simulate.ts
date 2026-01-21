import { streamText, type CoreMessage } from "ai"
import { Provider } from "@/provider/provider"

export namespace Simulate {
  export interface Config {
    model: { providerID: string; modelID: string }
    maxTurns: number
  }

  export type Status = "idle" | "generating" | "waiting" | "completed" | "cancelled" | "stopped"

  export interface ParsedResponse {
    stopped: boolean
    reason?: string
    task?: string
  }

  const STOP_REGEX = /<STOP>([\s\S]*?)<\/STOP>/

  const SIMULATOR_SYSTEM_PROMPT = `You are a task generator simulating a developer using an AI coding assistant.

Your role:
1. Analyze the conversation history and current state
2. Generate the next logical task/instruction for the assistant
3. Act as if you are a developer giving clear, actionable instructions

Rules:
- Generate clear, specific, actionable tasks
- One task at a time
- Monitor the assistant's responses for success or failure
- When finished (goal achieved or no more useful tasks), output: <STOP>reason</STOP>
- Do not include any other text when stopping, just the stop tag

Output only the task text (or stop tag). No explanations or meta-commentary.`

  export function parseSimulatorResponse(text: string): ParsedResponse {
    const match = text.match(STOP_REGEX)
    if (match) {
      return { stopped: true, reason: match[1].trim() }
    }
    return { stopped: false, task: text.trim() }
  }

  export async function generateTask(
    config: Config,
    conversationHistory: CoreMessage[],
    abortSignal: AbortSignal,
  ): Promise<{ text: string; parsed: ParsedResponse }> {
    const model = await Provider.getModel(config.model.providerID, config.model.modelID)
    if (!model) {
      throw new Error(`Model not found: ${config.model.providerID}/${config.model.modelID}`)
    }

    const language = await Provider.getLanguage(model)

    const result = await streamText({
      model: language,
      messages: conversationHistory,
      system: SIMULATOR_SYSTEM_PROMPT,
      abortSignal,
    })

    const text = await result.text
    const parsed = parseSimulatorResponse(text)

    return { text, parsed }
  }

  export function buildSimulatorContext(
    agentMessages: Array<{ role: "user" | "assistant"; content: string }>,
  ): CoreMessage[] {
    return agentMessages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }))
  }
}

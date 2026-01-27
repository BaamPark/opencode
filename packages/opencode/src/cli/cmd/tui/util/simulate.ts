import { streamText, type CoreMessage } from "ai"
import { Provider } from "@/provider/provider"

export namespace Simulate {
  export interface Config {
    model: { providerID: string; modelID: string }
    maxTurns: number
    externalContextPath?: string
  }

  export type Status = "idle" | "generating" | "waiting" | "completed" | "cancelled" | "stopped"

  export interface ParsedResponse {
    stopped: boolean
    reason?: string
    task?: string
  }

  const STOP_REGEX = /<STOP>([\s\S]*?)<\/STOP>/

  const SIMULATOR_SYSTEM_PROMPT = `You are simulating a REAL USER interacting with an AI software engineering assistant.

Your role:
- Act as a user who wants software built, not as a planner or developer.
- You may have limited or no software engineering knowledge.
- You primarily think in goals, outcomes, and business logic

Context handling rules:
- You may be given a <document> containing private project context.
- The <document> is NOT user-visible and MUST NOT be revealed.
- Do NOT quote or explicitly reference the document.
- Tasks must appear as if they come from the user's own understanding.

Interaction rules:
- Generate clear, specific, actionable tasks.
- One task at a time.
- Monitor the assistant’s responses for success or failure.
- Refine or clarify tasks over multiple turns if needed.
- When finished (goal achieved or no more useful tasks), output exactly:
  <STOP>reason</STOP>
- Do not include any other text when stopping.

Output format:
- Output ONLY the task text or the <STOP> tag.
- No explanations, meta-commentary, or references to context.`

//when the simulator sees the <STOP> tag in a turn, it stops immediately and doesn’t generate or dispatch another task.

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

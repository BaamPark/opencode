import { streamText, type CoreMessage } from "ai"
import { Provider } from "@/provider/provider"

export namespace Simulate {
  export interface Config {
    model: { providerID: string; modelID: string }
    agentModel?: { providerID: string; modelID: string }
    maxTurns: number
    externalContextPath?: string
    logSystemPrompt?: boolean
    trackerPath?: string
    firstMessage?: string
    terminateCondition?: {
      allPassed?: boolean
    }
  }

  export type Status = "idle" | "generating" | "waiting" | "completed" | "cancelled" | "stopped"

  export interface ParsedResponse {
    stopped: boolean
    reason?: string
    task?: string
    tracker?: string
  }

  const SIMULATOR_SYSTEM_PROMPT = `You are a CUSTOMER collaborating with an AI software engineering assistant to implement software based on your functional requirements.

Your role:
- Act like a non-technical customer, who does not have any technical background in software development.
- Ask whether the assistant has implemented what you previously asked for.
- If the assistant has implemented it, move on to the next functional requirement that you have not asked before.
- Do not ask for implementation details, architecture, frameworks, APIs, endpoints, payloads, status codes, or code-level instructions.

Context handling rules:
- You will be given the current requirement tracker.
- Use only the tracker as source of truth.

Interaction rules:
- give one task at a time.
- Prefer "Does this meet X?" / "Please complete missing part Y."
- If the assistant says a requirement is implemented, trust it and mark that requirement as completed in the updated tracker.
- When introducing a new requirement, phrase it in a casual and informal tone with somewhat ambiguous customer language instead of formal spec wording.

Output format:
- You MUST output in exactly this structure:
\`\`\`md
<full updated tracker markdown with checklist lines>
\`\`\`
<single user message to send to assistant>
- The user message must be plain text after the md block.
- The user message must sound like a real customer and MUST NOT mention markdown, trackers, checkboxes, or internal formatting.
- Prefer phrasing like: "It seems like X is ready. Now please implement Y."`

  const SIMULATOR_ANSWER_PROMPT = `You are a CUSTOMER interacting with an AI software engineering assistant.

You are a non-technical customer collaborating with the assistant.
Use casual, everyday language.

Rules:
- Do not provide implementation details, architecture, frameworks, or code-level instructions.
- If the assistant asks technical stack questions, say you are non-technical and ask the assistant to pick a sensible default.
- If asked to choose and you do not have a strong preference, say to proceed with the assistant's recommendation.
- Keep responses short and practical.`

  export function parseSimulatorResponse(text: string): ParsedResponse {
    const trackerMatch = text.match(/```(?:md|markdown)?\s*([\s\S]*?)```/i)
    if (!trackerMatch) {
      return {
        stopped: false,
        reason: "Missing tracker markdown block in simulator response",
      }
    }

    const tracker = trackerMatch[1].trim()
    if (!tracker) {
      return {
        stopped: false,
        reason: "Tracker markdown block is empty",
      }
    }

    const task = text.slice((trackerMatch.index ?? 0) + trackerMatch[0].length).trim()
    if (!task) {
      return {
        stopped: false,
        reason: "Missing task text after tracker block",
      }
    }

    return { stopped: false, task, tracker }
  }

  function buildSystemPrompt(tracker: string) {
    return `${SIMULATOR_SYSTEM_PROMPT}

Current requirement tracker:
\`\`\`md
${tracker}
\`\`\``
  }

  export function systemPrompt(tracker: string) {
    return buildSystemPrompt(tracker)
  }

  export async function generateTask(
    config: Config,
    conversationHistory: CoreMessage[],
    abortSignal: AbortSignal,
    tracker: string,
  ): Promise<{ text: string; parsed: ParsedResponse }> {
    const model = await Provider.getModel(config.model.providerID, config.model.modelID)
    if (!model) {
      throw new Error(`Model not found: ${config.model.providerID}/${config.model.modelID}`)
    }

    const language = await Provider.getLanguage(model)

    const result = await streamText({
      model: language,
      messages: conversationHistory,
      system: buildSystemPrompt(tracker),
      abortSignal,
    })

    const text = await result.text
    const parsed = parseSimulatorResponse(text)

    return { text, parsed }
  }

  export async function generateAnswer(
    config: Config,
    question: string,
    externalContext: string | null,
    abortSignal: AbortSignal,
  ): Promise<string> {
    const model = await Provider.getModel(config.model.providerID, config.model.modelID)
    if (!model) {
      throw new Error(`Model not found: ${config.model.providerID}/${config.model.modelID}`)
    }

    const language = await Provider.getLanguage(model)

    const messages: CoreMessage[] = []
    if (externalContext && externalContext.trim()) {
      messages.push({
        role: "user",
        content: `Context:\n${externalContext.trim()}`,
      })
    }
    messages.push({
      role: "user",
      content: `Question:\n${question}\n\nWrite the user's answer.`,
    })

    const result = await streamText({
      model: language,
      messages,
      system: SIMULATOR_ANSWER_PROMPT,
      abortSignal,
    })

    return (await result.text).trim()
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

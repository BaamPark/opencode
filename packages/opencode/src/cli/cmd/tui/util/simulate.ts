import { streamText, type CoreMessage } from "ai"
import { Provider } from "@/provider/provider"

export namespace Simulate {
  export interface TokenUsage {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
    total: number
  }

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
    formatRetryCount?: number
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
- In the tracker markdown, completed requirements MUST be marked as "- [x] requirement".
- Keep each requirement text unchanged when marking completion; only toggle "[ ]" to "[x]".
- The user message must be plain text after the md block.
- The user message must sound like a nont-techincal customer and MUST NOT mention markdown, trackers, checkboxes, or internal formatting.
- Vary sentence openings and phrasing naturally across turns.`

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

  export function isMissingTrackerBlock(reason?: string) {
    return reason === "Missing tracker markdown block in simulator response"
  }

  function toSafeNumber(value: unknown) {
    const num = typeof value === "number" ? value : Number(value)
    return Number.isFinite(num) ? num : 0
  }

  function pickNumber(raw: any, keys: string[]) {
    for (const key of keys) {
      if (raw?.[key] !== undefined && raw?.[key] !== null) {
        return toSafeNumber(raw[key])
      }
    }
    return 0
  }

  function normalizeUsage(raw: any): TokenUsage | undefined {
    if (!raw || typeof raw !== "object") return
    const input = pickNumber(raw, ["inputTokens", "promptTokens", "input", "prompt"])
    const output = pickNumber(raw, ["outputTokens", "completionTokens", "output", "completion"])
    const reasoning = pickNumber(raw, ["reasoningTokens", "reasoning"])
    const cacheRead = pickNumber(raw, ["cachedInputTokens", "cacheRead"])
    const cacheWrite = pickNumber(raw, ["cacheCreationInputTokens", "cacheWrite"])
    const explicitTotal = pickNumber(raw, ["totalTokens", "total"])
    const total = explicitTotal > 0 ? explicitTotal : input + output + reasoning + cacheRead + cacheWrite
    if (total <= 0) return
    return { input, output, reasoning, cacheRead, cacheWrite, total }
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
  ): Promise<{ text: string; parsed: ParsedResponse; usage?: TokenUsage }> {
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
    const directUsage = normalizeUsage((result as any).usage)
    const resolvedUsage = directUsage ?? normalizeUsage(await Promise.resolve((result as any).usage))
    const totalUsage = normalizeUsage(await Promise.resolve((result as any).totalUsage))
    const usage = resolvedUsage ?? totalUsage

    return { text, parsed, usage }
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

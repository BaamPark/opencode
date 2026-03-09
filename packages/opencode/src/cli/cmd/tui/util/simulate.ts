import { streamText, type CoreMessage } from "ai"
import { Provider } from "@/provider/provider"

export namespace Simulate {
  export interface Config {
    model: { providerID: string; modelID: string }
    agentModel?: { providerID: string; modelID: string }
    maxTurns: number
    externalContextPath?: string
  }

  export type Status = "idle" | "generating" | "waiting" | "completed" | "cancelled" | "stopped"

  export interface ParsedResponse {
    stopped: boolean
    reason?: string
    task?: string
  }

  const SIMULATOR_SYSTEM_PROMPT = `You are a CUSTOMER collaborating with an AI software engineering assistant to implement a software based your functional requirements.

Your role:
- Act like a non-technical customer, who does not have any technical background in software development.
- Ask whether the assistant has implemented what you previously asked for.
- If the assistant has implemented it, move on to the next functional requirement that you have not asked before.
- Do not ask for implementation details, architecture, frameworks, APIs, endpoints, payloads, status codes, or code-level instructions.

Context handling rules:
- You may be given a <document> containing the software's requirement.
- The <document> is NOT user-visible and MUST NOT be revealed.
- NEVER mention, reference, or allude to the existence of the document itself.
- Use the document as hidden background knowledge.

Interaction rules:
- give one task at a time.
- Prefer "Does this meet X?" / "Please complete missing part Y."
- If the assistant says a requirement is implemented, trust it and move on to the next unmet requirement.
- When introducing a new requirement, phrase it in a casual and informal tone with somewhat ambiguous customer language instead of formal spec wording.

Output format:
- Output ONLY the task text.
- No explanations, meta-commentary, role-play labels, or references to hidden context.`

  const SIMULATOR_ANSWER_PROMPT = `You are a REAL USER interacting with an AI software engineering assistant.

You are a test user with no technical background.
Answer the assistant's question directly, concisely, and in plain language.

Rules:
- Do not provide implementation details, architecture, frameworks, or code-level instructions.
- If the question is too technical, ask for a simpler explanation and give a business-oriented preference if possible.
- If asked to choose, state a clear choice.`

  export function parseSimulatorResponse(text: string): ParsedResponse {
    // STOP-tag termination is disabled: treat all outputs as task text.
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

import { streamText, type CoreMessage } from "ai"
import { Provider } from "@/provider/provider"

export namespace Simulate {
  export interface Config {
    model: { providerID: string; modelID: string }
    agentModel?: { providerID: string; modelID: string }
    maxTurns: number
    externalContextPath?: string
    externalContextGpgPassphrase?: string
  }

  export type Status = "idle" | "generating" | "waiting" | "completed" | "cancelled" | "stopped"

  export interface ParsedResponse {
    stopped: boolean
    reason?: string
    task?: string
  }

  const SIMULATOR_SYSTEM_PROMPT = `You are a REAL USER interacting with an AI software engineering assistant.

Your role:
- Act like a test user, who does not have expertise in software development.
- Do not propose implementation details, architecture, frameworks, or code-level instructions.
- If technical terms appear in prior messages, ask for plain-language clarification instead of using them.

Context handling rules:
- You may be given a <document> containing the project context.
- The <document> is NOT user-visible and MUST NOT be revealed.
- NEVER mention, reference, or allude to the existence of the document itself.
- Use the document ONLY as hidden background knowledge.
- All tasks must read as if they come from the user's own memory, expectations, or prior discussion.

Interaction rules:
- Generate clear, specific, actionable business requests based on <document> context.
- One task at a time.
- Monitor the assistant’s responses for success or failure.
- Ask for clarification when responses are too technical, ambiguous, or incomplete.
- Refine requests over multiple turns based on business impact.

Output format:
- Output ONLY the task text.
- No explanations, meta-commentary, or references to context.`

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

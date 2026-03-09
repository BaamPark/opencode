import { jsonSchema, streamText, tool, type CoreMessage } from "ai"
import { Provider } from "@/provider/provider"
import fs from "fs/promises"

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
- You MUST use the edit_tracker tool to mark completed requirements in the tracker file whenever the assistant says a requirement is implemented.

Interaction rules:
- give one task at a time.
- Prefer "Does this meet X?" / "Please complete missing part Y."
- If the assistant says a requirement is implemented, trust it and move on to the next unmet requirement.
- When introducing a new requirement, phrase it in a casual and informal tone with somewhat ambiguous customer language instead of formal spec wording.

Output format:
- Output ONLY the task text.
- No explanations, meta-commentary, role-play labels, or references to hidden context.`

  const TRACKER_FILE_PATH = "/doc/req_tracker.md"

  function normalizeRequirement(input: string) {
    return input.toLowerCase().replace(/\s+/g, " ").trim()
  }

  function markRequirementDone(content: string, requirement: string) {
    const newline = content.includes("\r\n") ? "\r\n" : "\n"
    const lines = content.split(/\r?\n/)
    const target = normalizeRequirement(requirement)
    if (!target) throw new Error("requirement is required")

    let alreadyChecked: string | null = null
    let updatedTitle: string | null = null

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^\s*-\s*\[( |x|X)\]\s*(.+)\s*$/)
      if (!match) continue
      const checked = match[1].toLowerCase() === "x"
      const body = match[2]
      const normalizedBody = normalizeRequirement(body)
      const title = body.split(":")[0]?.trim() ?? body.trim()
      const normalizedTitle = normalizeRequirement(title)
      const isMatch =
        normalizedBody.includes(target) ||
        target.includes(normalizedBody) ||
        normalizedTitle.includes(target) ||
        target.includes(normalizedTitle)

      if (!isMatch) continue

      if (checked) {
        alreadyChecked = body
        break
      }

      lines[i] = lines[i].replace(/\[( )\]/, "[x]")
      updatedTitle = body
      break
    }

    if (updatedTitle) {
      return {
        content: lines.join(newline),
        status: "updated" as const,
        line: updatedTitle,
      }
    }

    if (alreadyChecked) {
      return {
        content,
        status: "already_checked" as const,
        line: alreadyChecked,
      }
    }

    throw new Error(`Requirement not found in tracker: ${requirement}`)
  }

  const SIMULATOR_ANSWER_PROMPT = `You are a CUSTOMER interacting with an AI software engineering assistant.

You are a non-technical customer collaborating with the assistant.
Use casual, everyday language.

Rules:
- Do not provide implementation details, architecture, frameworks, or code-level instructions.
- If the assistant asks technical stack questions, say you are non-technical and ask the assistant to pick a sensible default.
- If asked to choose and you do not have a strong preference, say to proceed with the assistant's recommendation.
- Keep responses short and practical.`

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

    const editTrackerTool = tool({
      description: "Mark a completed requirement in /doc/req_tracker.md by changing [ ] to [x]",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          requirement: {
            type: "string",
            description: "Requirement title or text to mark as completed",
          },
        },
        required: ["requirement"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        const requirement = typeof (input as Record<string, unknown>)?.["requirement"] === "string"
          ? ((input as Record<string, unknown>)["requirement"] as string)
          : ""
        const original = await fs.readFile(TRACKER_FILE_PATH, "utf8")
        const result = markRequirementDone(original, requirement)
        if (result.status === "updated") {
          await fs.writeFile(TRACKER_FILE_PATH, result.content, "utf8")
        }
        return {
          filePath: TRACKER_FILE_PATH,
          status: result.status,
          requirement: result.line,
        }
      },
    })

    const result = await streamText({
      model: language,
      messages: conversationHistory,
      system: SIMULATOR_SYSTEM_PROMPT,
      tools: {
        edit_tracker: editTrackerTool,
      },
      activeTools: ["edit_tracker"],
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

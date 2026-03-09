import { createStore, produce } from "solid-js/store"
import { batch, createEffect, onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useLocal } from "./local"
import { useToast } from "../ui/toast"
import { Simulate } from "../util/simulate"
import { Identifier } from "@/id/id"
import type { CoreMessage } from "ai"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import fs from "fs/promises"
import path from "path"
import { formatTranscript } from "../util/transcript"

export interface SimulationState {
  active: boolean
  sessionID: string | null
  config: Simulate.Config | null
  currentTurn: number
  status: Simulate.Status
  stopReason: string | null
  error: string | null
}

export const { use: useSimulate, provider: SimulateProvider } = createSimpleContext({
  name: "Simulate",
  init: () => {
    const DEFAULT_TRACKER_FILE_PATH = "/docs/req_tracker.md"
    const SIMULATOR_PROMPT_LOG_PATH = "/workspace/simulator-system-prompt.log"
    const sdk = useSDK()
    const sync = useSync()
    const local = useLocal()
    const toast = useToast()

    const [store, setStore] = createStore<SimulationState>({
      active: false,
      sessionID: null,
      config: null,
      currentTurn: 0,
      status: "idle",
      stopReason: null,
      error: null,
    })

    let abortController: AbortController | null = null
    let simulatorContext: CoreMessage[] = []
    let pendingAgentMessageID: string | null = null
    let pendingAssistantContent: string | null = null
    let trackerLoaded = false
    let trackerState = ""
    let promptLogFailed = false
    let seedFirstPrompt = false
    let seedFirstPromptTask: string | null = null
    function reset() {
      batch(() => {
        setStore("active", false)
        setStore("sessionID", null)
        setStore("config", null)
        setStore("currentTurn", 0)
        setStore("status", "idle")
        setStore("stopReason", null)
        setStore("error", null)
      })
      abortController = null
      simulatorContext = []
      pendingAgentMessageID = null
      pendingAssistantContent = null
      trackerLoaded = false
      trackerState = ""
      promptLogFailed = false
      seedFirstPrompt = false
      seedFirstPromptTask = null
    }

    async function start(sessionID: string, config: Simulate.Config, initialPrompt?: string) {
      if (store.active) return

      abortController = new AbortController()
      simulatorContext = []
      trackerLoaded = false
      trackerState = ""
      promptLogFailed = false

      batch(() => {
        setStore("active", true)
        setStore("sessionID", sessionID)
        setStore("config", config)
        setStore("currentTurn", 0)
        setStore("status", "generating")
        setStore("stopReason", null)
        setStore("error", null)
      })

      // Build context from existing session messages
      const messages = sync.data.message[sessionID] || []
      seedFirstPrompt = messages.length === 0
      seedFirstPromptTask = initialPrompt?.trim() || config.firstMessage?.trim() || null
      for (const msg of messages) {
        const parts = sync.data.part[msg.id] || []
        const textParts = parts.filter((p: { type: string }) => p.type === "text")
        const content = textParts.map((p: { type: string; text?: string }) => p.text || "").join("\n")

        if (content.trim()) {
          if (msg.role === "user") {
            simulatorContext.push({
              role: "user",
              content: `The user asked the coding assistant:\n\n${content}`,
            })
          } else if (msg.role === "assistant") {
            simulatorContext.push({
              role: "user", // From simulator's perspective, agent responses are input
              content: `The coding assistant responded:\n\n${content}`,
            })
          }
        }
      }

      // Add instruction for the simulator
      simulatorContext.push({
        role: "user",
        content:
          "Now continue the session.\n\nWrite the next message as a real user, in casual, conversational plain text.\n\nFirst, look at the coding assistant's most recent response.\nCompare it against the current requirement tracker:\n- if the response does not satisfy the current item, is incomplete, or feels confusing, ask the assistant to fix or clarify it\n- if the response seems complete, move to the next unfinished requirement\n\nReturn the next user message using the required output format.",
      })

      toast.show({
        variant: "info",
        message: `Simulation started (max ${config.maxTurns} turns)`,
        duration: 3000,
      })

      try {
        await runNextTurn()
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Unknown error"
        toast.show({
          variant: "error",
          message: `Simulation failed: ${errorMessage}`,
          duration: 5000,
        })
        batch(() => {
          setStore("status", "cancelled")
          setStore("error", errorMessage)
          setStore("active", false)
        })
      }
    }

    async function dispatchTask(task: string) {
      const trimmedTask = task.trim()
      if (!trimmedTask) {
        complete("stopped", "Simulator generated empty task")
        return
      }

      simulatorContext.push({
        role: "assistant",
        content: trimmedTask,
      })

      setStore("status", "waiting")

      const messageID = Identifier.ascending("message")
      pendingAgentMessageID = messageID
      pendingAssistantContent = null

      await sdk.client.session.prompt({
        sessionID: store.sessionID!,
        messageID,
        model: store.config?.agentModel ?? local.model.current() ?? undefined,
        parts: [
          {
            id: Identifier.ascending("part"),
            type: "text",
            text: trimmedTask,
          },
        ],
      })
    }

    async function runNextTurn() {
      if (!store.active || !store.config || !store.sessionID) return
      if (abortController?.signal.aborted) return

      const turn = store.currentTurn + 1
      if (turn > store.config.maxTurns) {
        complete("completed", "Maximum turns reached")
        return
      }

      setStore("currentTurn", turn)
      setStore("status", "generating")

      try {
        await ensureTrackerState()

        if (seedFirstPromptTask && turn === 1) {
          const task = seedFirstPromptTask
          seedFirstPromptTask = null
          await dispatchTask(task)
          return
        }

        const directory = sync.data.path.directory
        if (!directory) throw new Error("Project directory not available")
        await logSimulatorSystemPrompt(turn)
        const { text, parsed } = await Instance.provide({
          directory,
          init: InstanceBootstrap,
          fn: () => Simulate.generateTask(store.config!, simulatorContext, abortController!.signal, trackerState),
        })

        if (abortController?.signal.aborted) return

        if (parsed.stopped) {
          complete("stopped", parsed.reason || "Simulator decided to stop")
          return
        }

        if (parsed.reason) {
          complete("stopped", parsed.reason)
          return
        }

        if (!parsed.tracker || parsed.tracker.trim() === "") {
          complete("stopped", "Simulator response did not include updated tracker")
          return
        }
        trackerState = parsed.tracker.trim()

        if (!parsed.task || parsed.task.trim() === "") {
          complete("stopped", "Simulator generated empty task")
          return
        }

        await dispatchTask(parsed.task)
      } catch (err) {
        if (abortController?.signal.aborted) return
        const errorMessage = err instanceof Error ? err.message : "Unknown error"
        toast.show({
          variant: "error",
          message: `Simulation error: ${errorMessage}`,
          duration: 5000,
        })
        batch(() => {
          setStore("status", "cancelled")
          setStore("error", errorMessage)
          setStore("active", false)
        })
      }
    }

    async function ensureTrackerState() {
      if (trackerLoaded) return
      const baseDir = sync.data.path.directory
      if (!baseDir) throw new Error("Project directory not available")
      const configured = store.config?.trackerPath?.trim()
      const trackerPath = configured
        ? path.isAbsolute(configured)
          ? configured
          : path.join(baseDir, configured)
        : DEFAULT_TRACKER_FILE_PATH
      try {
        trackerState = (await fs.readFile(trackerPath, "utf8")).trim()
      } catch {
        throw new Error(`Tracker file not found: ${trackerPath}`)
      }

      if (!trackerState) throw new Error(`Tracker file is empty: ${trackerPath}`)

      trackerLoaded = true
    }

    async function logSimulatorSystemPrompt(turn: number) {
      if (store.config?.logSystemPrompt !== true) return
      if (promptLogFailed) return
      try {
        const prompt = Simulate.systemPrompt(trackerState)
        const record = [
          "============================================================",
          `time: ${new Date().toISOString()}`,
          `turn: ${turn}`,
          `session: ${store.sessionID ?? "unknown"}`,
          "",
          prompt,
          "",
        ].join("\n")
        await fs.appendFile(SIMULATOR_PROMPT_LOG_PATH, record, "utf8")
      } catch {
        promptLogFailed = true
        toast.show({
          variant: "warning",
          message: `Failed to write simulator prompt log: ${SIMULATOR_PROMPT_LOG_PATH}`,
          duration: 4000,
        })
      }
    }

    function pickAnswerFromContext(questionText: string, options: string[]) {
      if (options.length === 0) return null
      const haystack = `${questionText}\n${trackerState}`.toLowerCase()
      for (const option of options) {
        const needle = option.toLowerCase()
        if (needle && haystack.includes(needle)) return option
      }
      return options[0]
    }

    async function generateCustomAnswer(questionText: string, multiple: boolean) {
      const config = store.config
      if (!config) {
        return [
          `auto-answer fallback: hasConfig=${Boolean(config)} hasAbort=${Boolean(
            abortController,
          )} (no model call)`,
        ]
      }
      let answerText = ""
      try {
        const directory = sync.data.path.directory
        if (!directory) throw new Error("Project directory not available")
        const signal = abortController?.signal ?? new AbortController().signal
        answerText = await Instance.provide({
          directory,
          init: InstanceBootstrap,
          fn: () =>
            Simulate.generateAnswer(config, questionText, trackerState || null, signal),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error"
        toast.show({
          variant: "error",
          message: `Simulation auto-answer failed: ${message}`,
          duration: 5000,
        })
        return [`Simulation auto-answer failed: ${message}`]
      }
      if (!answerText) return ["answer text is empty"]
      if (multiple) {
        const parts = answerText
          .split(/[\n,]+/)
          .map((part) => part.trim())
          .filter(Boolean)
        return parts.length > 0 ? parts : [answerText.trim()]
      }
      return [answerText.trim()]
    }

    async function autoAnswerQuestion(request: {
      id: string
      questions: Array<{
        question: string
        options?: Array<{ label: string }>
        multiple?: boolean
        custom?: boolean
      }>
    }) {
      if (!store.active || !store.sessionID) return
      await ensureTrackerState()
      const answers = await Promise.all(
        request.questions.map(async (q) => {
          if (q.custom !== false) {
            return generateCustomAnswer(q.question, q.multiple === true)
          }
        const options = (q.options ?? []).map((o) => o.label).filter((o) => o)
        const haystack = `${q.question}\n${trackerState}`.toLowerCase()
        if (q.multiple) {
          const picked = options.filter((opt) => haystack.includes(opt.toLowerCase()))
          if (picked.length > 0) return picked
          return options.length > 0 ? [options[0]] : q.custom === false ? [] : ["Not specified"]
        }
        const picked = pickAnswerFromContext(q.question, options)
        if (picked) return [picked]
        return q.custom === false ? [] : ["Not specified"]
        }),
      )

      sdk.client.question.reply({
        requestID: request.id,
        answers,
      })
    }

    function isSessionIdle() {
      const sessionID = store.sessionID
      if (!sessionID) return true
      const status = sync.data.session_status[sessionID]
      return !status || status.type === "idle"
    }

    function flushPendingAssistant() {
      if (!store.active) return
      if (store.status !== "waiting") return
      if (!pendingAssistantContent) return
      if (!isSessionIdle()) return
      const content = pendingAssistantContent
      pendingAssistantContent = null
      handleAgentComplete(content)
    }

    function handleAgentComplete(messageContent: string) {
      if (!store.active) return

      simulatorContext.push({
        role: "user",
        content: `The coding assistant responded:\n\n${messageContent}`,
      })

      pendingAgentMessageID = null
      runNextTurn()
    }

    function complete(status: "completed" | "stopped", reason: string) {
      toast.show({
        variant: "info",
        message: `Simulation ${status}: ${reason}`,
        duration: 5000,
      })
      if (store.sessionID) {
        void exportSimulationTranscript(store.sessionID)
      }
      batch(() => {
        setStore("status", status)
        setStore("stopReason", reason)
        setStore("active", false)
      })
      abortController = null
      simulatorContext = []
      pendingAgentMessageID = null
      pendingAssistantContent = null
    }

    function cancel() {
      if (!store.active) return
      abortController?.abort()
      batch(() => {
        setStore("status", "cancelled")
        setStore("active", false)
      })
      abortController = null
      simulatorContext = []
      pendingAgentMessageID = null
      pendingAssistantContent = null
    }

    async function exportSimulationTranscript(sessionID: string) {
      try {
        const [sessionResult, messagesResult] = await Promise.all([
          sdk.client.session.get({ sessionID }, { throwOnError: true }),
          sdk.client.session.messages({ sessionID }, { throwOnError: true }),
        ])
        const sessionData = sessionResult.data
        if (!sessionData) return
        const sessionMessages = messagesResult.data ?? []
        const transcript = formatTranscript(
          sessionData,
          sessionMessages.map((msg) => ({ info: msg.info, parts: msg.parts })),
          { thinking: false, toolDetails: false, assistantMetadata: false },
        )
        const filename = `session-${sessionData.id.slice(0, 8)}.md`
        const filepath = path.join(process.cwd(), filename)
        await Bun.write(filepath, transcript)
        toast.show({ message: `Session exported to ${filename}`, variant: "success" })
      } catch {
        toast.show({ message: "Failed to export session", variant: "error" })
      }
    }

    sdk.event.listen((e) => {
      const event = e.details
      if (!store.active) return

      if (event.type === "session.status") {
        if (event.properties.sessionID !== store.sessionID) return
        if (event.properties.status.type !== "idle") return
        flushPendingAssistant()
        return
      }

      if (event.type === "question.asked") {
        if (event.properties.sessionID !== store.sessionID) return
        void autoAnswerQuestion(event.properties)
        return
      }

      if (event.type !== "message.updated") return
      if (store.status !== "waiting") return

      const msg = event.properties.info
      if (msg.sessionID !== store.sessionID) return
      if (msg.role !== "assistant") return
      if (!msg.time.completed) return

      const parts = sync.data.part[msg.id] || []
      const textParts = parts.filter((p: { type: string }) => p.type === "text")
      const content = textParts.map((p: { type: string; text?: string }) => p.text || "").join("\n")

      pendingAssistantContent = content
      flushPendingAssistant()
    })

    return {
      get state() {
        return store
      },
      start,
      cancel,
    }
  },
})


/* RAW PROMPT
<SYSTEM>
You are simulating a REAL USER interacting with an AI software engineering assistant.
...
</SYSTEM>

<SYSTEM>
<document>
File: README.md
# OpenCode Simulator

This project is a CLI tool written in TypeScript.
It uses Bun for builds.
The /simulate command generates user tasks.
</document>
</SYSTEM>

<USER>
The user asked the coding assistant:

Add a simulate command
</USER>

<USER>
The coding assistant responded:

I added a basic /simulate command
</USER>

<USER>
Now continue the session. Based on the conversation above, generate the next task for the coding assistant to improve or extend the work.
</USER>

<ASSISTANT>
*/

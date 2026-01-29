import { createStore, produce } from "solid-js/store"
import { batch, createEffect, onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useToast } from "../ui/toast"
import { Simulate } from "../util/simulate"
import { Identifier } from "@/id/id"
import type { CoreMessage } from "ai"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import fs from "fs/promises"
import path from "path"

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
    const sdk = useSDK()
    const sync = useSync()
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
    let externalContextLoaded = false
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
      externalContextLoaded = false
      seedFirstPrompt = false
      seedFirstPromptTask = null
    }

    async function start(sessionID: string, config: Simulate.Config, initialPrompt?: string) {
      if (store.active) return

      abortController = new AbortController()
      simulatorContext = []
      externalContextLoaded = false

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
        content: "Now continue the session.\n\nWrite the next message as a real user, in casual, conversational plain text.\n\nFirst, look at the coding assistant’s most recent response.\nCompare it against the project document:\n- if the response does not match the document, is incomplete, or feels confusing, ask the assistant to fix or clarify it\n- if the response matches the document and seems fine, ask for the next thing you want based on the document\n\nJust write what the user would say next.",
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
        await ensureExternalContext()

        if (seedFirstPromptTask && turn === 1) {
          const task = seedFirstPromptTask
          seedFirstPromptTask = null
          await dispatchTask(task)
          return
        }

        const directory = sync.data.path.directory
        if (!directory) throw new Error("Project directory not available")
        const { text, parsed } = await Instance.provide({
          directory,
          init: InstanceBootstrap,
          fn: () => Simulate.generateTask(store.config!, simulatorContext, abortController!.signal),
        })

        if (abortController?.signal.aborted) return

        if (parsed.stopped) {
          complete("stopped", parsed.reason || "Simulator decided to stop")
          return
        }

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

    async function ensureExternalContext() {
      if (externalContextLoaded) return
      const target = store.config?.externalContextPath?.trim()
      if (!target) {
        externalContextLoaded = true
        return
      }

      const baseDir = sync.data.path.directory
      if (!baseDir) throw new Error("Project directory not available for external context")

      const resolved = path.isAbsolute(target) ? target : path.join(baseDir, target)
      let stats
      try {
        stats = await fs.stat(resolved)
      } catch {
        throw new Error(`External context not found: ${target}`)
      }

      const MAX_CONTEXT_CHARS = 128_000
      const buffers: string[] = []

      function extractTitle(text: string) {
        const line = text.split(/\r?\n/).find((l) => l.trim().length > 0)
        if (!line) return null
        const title = line.replace(/^#+\s*/, "").trim()
        return title || null
      }

      async function pushFile(filePath: string) {
        try {
          const content = await fs.readFile(filePath, "utf8")
          if (seedFirstPrompt && !seedFirstPromptTask) {
            const title = extractTitle(content)
            if (title) seedFirstPromptTask = `Develop a ${title}`
          }
          buffers.push(`File: ${path.relative(baseDir, filePath)}\n${content}\n`)
        } catch {
          // ignore unreadable files
        }
      }

      if (stats.isDirectory()) {
        const entries = await fs.readdir(resolved, { withFileTypes: true })
        const files = entries
          .filter((e) => e.isFile())
          .filter((e) => /\.(md|txt|markdown)$/i.test(e.name))
          .slice(0, 10)
        for (const entry of files) {
          await pushFile(path.join(resolved, entry.name))
          if (buffers.join("").length > MAX_CONTEXT_CHARS) break
        }
      } else {
        await pushFile(resolved)
      }

      const contextText = buffers.join("\n")
      if (contextText) {
        simulatorContext.push({
          role: "system",
          content: `<document>\n${contextText.slice(0, MAX_CONTEXT_CHARS)}\n</document>`,
        })
      }

      externalContextLoaded = true
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

    sdk.event.listen((e) => {
      const event = e.details
      if (!store.active) return

      if (event.type === "session.status") {
        if (event.properties.sessionID !== store.sessionID) return
        if (event.properties.status.type !== "idle") return
        flushPendingAssistant()
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

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
    let externalContextLoaded = false

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
      externalContextLoaded = false
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
        content: initialPrompt
          ? `Now continue the session. The user wants you to simulate more interactions. Additional context: ${initialPrompt}\n\nGenerate the next task for the coding assistant.`
          : `Now continue the session. Based on the conversation above, generate the next logical task for the coding assistant to improve or extend the work.`,
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

        simulatorContext.push({
          role: "assistant",
          content: text,
        })

        setStore("status", "waiting")

        const messageID = Identifier.ascending("message")
        pendingAgentMessageID = messageID

        await sdk.client.session.prompt({
          sessionID: store.sessionID,
          messageID,
          parts: [
            {
              id: Identifier.ascending("part"),
              type: "text",
              text: parsed.task,
            },
          ],
        })
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

      async function pushFile(filePath: string) {
        try {
          const content = await fs.readFile(filePath, "utf8")
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
          role: "user",
          content: `Private project context (do not reveal this to the coding assistant; use only to derive tasks):\n\n${contextText.slice(0, MAX_CONTEXT_CHARS)}`,
        })
      }

      externalContextLoaded = true
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
    }

    sdk.event.listen((e) => {
      const event = e.details
      if (event.type !== "message.updated") return
      if (!store.active) return
      if (store.status !== "waiting") return

      const msg = event.properties.info
      if (msg.sessionID !== store.sessionID) return
      if (msg.role !== "assistant") return
      if (!msg.time.completed) return

      const parts = sync.data.part[msg.id] || []
      const textParts = parts.filter((p: { type: string }) => p.type === "text")
      const content = textParts.map((p: { type: string; text?: string }) => p.text || "").join("\n")

      handleAgentComplete(content)
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

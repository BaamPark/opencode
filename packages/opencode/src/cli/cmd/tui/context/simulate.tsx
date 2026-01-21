import { createStore, produce } from "solid-js/store"
import { batch, createEffect, onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { Simulate } from "../util/simulate"
import { Identifier } from "@/id/id"
import type { CoreMessage } from "ai"

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
    }

    async function start(sessionID: string, config: Simulate.Config, initialPrompt?: string) {
      if (store.active) return

      abortController = new AbortController()
      simulatorContext = []

      batch(() => {
        setStore("active", true)
        setStore("sessionID", sessionID)
        setStore("config", config)
        setStore("currentTurn", 0)
        setStore("status", "generating")
        setStore("stopReason", null)
        setStore("error", null)
      })

      if (initialPrompt) {
        simulatorContext.push({
          role: "user",
          content: `The user has provided this initial context for the simulation:\n\n${initialPrompt}\n\nBased on this, generate your first task for the coding assistant.`,
        })
      }

      await runNextTurn()
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
        const { text, parsed } = await Simulate.generateTask(
          store.config,
          simulatorContext,
          abortController!.signal,
        )

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
        batch(() => {
          setStore("status", "cancelled")
          setStore("error", errorMessage)
          setStore("active", false)
        })
      }
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

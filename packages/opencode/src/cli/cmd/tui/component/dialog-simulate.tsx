import { createMemo, createSignal, createEffect, Show } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { useSimulate } from "@tui/context/simulate"
import { map, pipe, flatMap, entries, filter, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useDialog } from "@tui/ui/dialog"
import * as fuzzysort from "fuzzysort"
import fs from "fs/promises"
import path from "path"
import { Provider } from "@/provider/provider"

type ModelRef = { providerID: string; modelID: string }

function DialogSimulateContext(props: {
  sessionID: string
  model: ModelRef
  maxTurns: number
  initialPrompt?: string
}) {
  const dialog = useDialog()
  const simulate = useSimulate()

  function start(path?: string) {
    dialog.clear()
    simulate.start(
      props.sessionID,
      {
        model: props.model,
        maxTurns: props.maxTurns,
        trackerPath: path?.trim() || undefined,
        logSystemPrompt: false,
      },
      props.initialPrompt,
    )
  }

  return (
    <DialogPrompt
      title="Tracker path (optional)"
      placeholder="path/to/req_tracker.md"
      value=""
      onCancel={() => start()}
      onConfirm={start}
      description={() => (
        <text>
          Provide a tracker markdown file path. If omitted, defaults to /docs/req_tracker.md.
        </text>
      )}
    />
  )
}

function DialogSimulateTurns(props: {
  sessionID: string
  model: ModelRef
  initialPrompt?: string
}) {
  const dialog = useDialog()

  return (
    <DialogPrompt
      title="Max turns"
      placeholder="10"
      value="10"
      onConfirm={(maxTurnsStr) => {
        const maxTurns = parseInt(maxTurnsStr, 10)
        if (isNaN(maxTurns) || maxTurns < 1) return
        dialog.replace(() => (
          <DialogSimulateContext
            sessionID={props.sessionID}
            model={props.model}
            maxTurns={maxTurns}
            initialPrompt={props.initialPrompt}
          />
        ))
      }}
      description={() => (
        <text>
          How many turns should the simulation run? The simulation will stop early if the
          simulator decides the task is complete.
        </text>
      )}
    />
  )
}

export function DialogSimulate(props: { sessionID: string; initialPrompt?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const simulate = useSimulate()

  const [query, setQuery] = createSignal("")
  const [autoState, setAutoState] = createSignal<"pending" | "started" | "fallback">("pending")

  function resolveModelRef(model: string | undefined): ModelRef | undefined {
    if (!model) return
    if (model.includes("/")) {
      const { providerID, modelID } = Provider.parseModel(model)
      if (!providerID || !modelID) return
      return { providerID, modelID }
    }
    const providers = sync.data.provider
    const matches = providers.filter((p) => p.models[model])
    if (matches.length === 1) {
      return { providerID: matches[0].id, modelID: model }
    }
  }

  async function loadSimulationConfig() {
    function parseConfigObject(data: any) {
      const simulatorModelStr = data.simulator_model ?? data.simulatorModel ?? data.model ?? data.models
      const agentModelStr = data.agent_model ?? data.agentModel
      const maxTurns = Number(data.max_turns ?? data.maxTurns)
      const trackerPath =
        data.tracker_path ?? data.trackerPath ?? data.tracker ?? data.external_context ?? data.externalContext
      const logSystemPromptRaw = data.log_system_prompt ?? data.logSystemPrompt
      const logMemoryParserRaw = data.log_memory_parser ?? data.logMemoryParser ?? data.loger
      const firstMessageRaw = data.first_message ?? data.firstMessage
      const terminateConditionRaw = data.terminate_condition ?? data.terminateCondition
      const allPassedRaw = terminateConditionRaw?.all_passed ?? terminateConditionRaw?.allPassed
      const formatRetryCountRaw = data.format_retry_count ?? data.formatRetryCount
      const optionsRaw = data.options
      const temperatureRaw = data.temperature ?? data.simulator_temperature ?? optionsRaw?.temperature
      const seedRaw = data.seed ?? data.simulator_seed ?? optionsRaw?.seed
      if (!simulatorModelStr || !trackerPath || !Number.isFinite(maxTurns) || maxTurns < 1) return
      const model = resolveModelRef(simulatorModelStr)
      if (!model) return
      const agentModel = agentModelStr ? resolveModelRef(agentModelStr) : undefined
      const parsedFormatRetryCount = Number(formatRetryCountRaw)
      const parsedTemperature = Number(temperatureRaw)
      const temperature =
        Number.isFinite(parsedTemperature) && parsedTemperature >= 0 ? parsedTemperature : undefined
      const parsedSeed = Number(seedRaw)
      const seed = Number.isFinite(parsedSeed) ? Math.floor(parsedSeed) : undefined
      const formatRetryCount =
        Number.isFinite(parsedFormatRetryCount) && parsedFormatRetryCount >= 0
          ? Math.floor(parsedFormatRetryCount)
          : 1
      return {
        model,
        agentModel,
        maxTurns,
        temperature,
        seed,
        trackerPath: String(trackerPath),
        logSystemPrompt: logSystemPromptRaw === true,
        logMemoryParser: logMemoryParserRaw === true,
        firstMessage: typeof firstMessageRaw === "string" ? firstMessageRaw : undefined,
        terminateCondition: {
          allPassed: allPassedRaw === true,
        },
        formatRetryCount,
      }
    }

    const envRaw = process.env["SIMULATION_CONFIG_JSON"] ?? process.env["OPENCODE_SIMULATION_CONFIG_JSON"]
    if (envRaw) {
      try {
        const parsed = parseConfigObject(JSON.parse(envRaw))
        if (parsed) {
          delete process.env["SIMULATION_CONFIG_JSON"]
          delete process.env["OPENCODE_SIMULATION_CONFIG_JSON"]
          return parsed
        }
      } catch {
        // fall through to file-based config
      }
    }

    const directory = sync.data.path.directory
    const worktree = sync.data.path.worktree
    const config = sync.data.path.config
    const candidates = [
      directory ? path.join(directory, ".opencode", "simulation.json") : undefined,
      worktree ? path.join(worktree, ".opencode", "simulation.json") : undefined,
      config ? path.join(config, "simulation.json") : undefined,
      "/.opencode/simulation.json",
    ].filter(Boolean) as string[]

    for (const filepath of candidates) {
      try {
        const raw = await fs.readFile(filepath, "utf8")
        const parsed = parseConfigObject(JSON.parse(raw))
        if (parsed) return parsed
      } catch {
        continue
      }
    }
  }

  createEffect(() => {
    if (autoState() !== "pending") return
    if (!sync.ready) return
    void (async () => {
      const config = await loadSimulationConfig()
      if (!config) {
        setAutoState("fallback")
        return
      }
      setAutoState("started")
      dialog.clear()
      simulate.start(props.sessionID, config, props.initialPrompt)
    })()
  })

  const options = createMemo(() => {
    const q = query()
    const needle = q.trim()

    const providerOptions = pipe(
      sync.data.provider,
      sortBy(
        (provider) => provider.id !== "opencode",
        (provider) => provider.name,
      ),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          map(([model, info]) => {
            const value: ModelRef = {
              providerID: provider.id,
              modelID: model,
            }
            return {
              value,
              title: info.name ?? model,
              category: provider.name,
              disabled: provider.id === "opencode" && model.includes("-nano"),
              footer: info.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
              onSelect: () => {
                dialog.replace(() => (
                  <DialogSimulateTurns
                    sessionID={props.sessionID}
                    model={value}
                    initialPrompt={props.initialPrompt}
                  />
                ))
              },
            }
          }),
          sortBy(
            (x) => x.footer !== "Free",
            (x) => x.title,
          ),
        ),
      ),
    )

    if (needle) {
      return fuzzysort.go(needle, providerOptions, { keys: ["title", "category"] }).map((x) => x.obj)
    }

    return providerOptions
  })

  return (
    <Show when={autoState() === "fallback"} fallback={<text>Starting simulation...</text>}>
      <DialogSelect
        title="Select simulator model"
        onFilter={setQuery}
        skipFilter={true}
        current={local.model.current()}
        options={options()}
      />
    </Show>
  )
}

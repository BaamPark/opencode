import { createMemo, createSignal } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { useSimulate } from "@tui/context/simulate"
import { map, pipe, flatMap, entries, filter, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useDialog } from "@tui/ui/dialog"
import * as fuzzysort from "fuzzysort"

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
      { model: props.model, maxTurns: props.maxTurns, externalContextPath: path?.trim() || undefined },
      props.initialPrompt,
    )
  }

  return (
    <DialogPrompt
      title="External context (optional)"
      placeholder="path/to/doc.md"
      value=""
      onCancel={() => start()}
      onConfirm={start}
      description={() => (
        <text>
          Provide a file or directory path for private simulator-only context. This content is not shared with the
          coding assistant; it is only used to derive the next task.
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

  const [query, setQuery] = createSignal("")

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
    <DialogSelect
      title="Select simulator model"
      onFilter={setQuery}
      skipFilter={true}
      current={local.model.current()}
      options={options()}
    />
  )
}

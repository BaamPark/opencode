import { type Accessor, createMemo, createSignal, Match, Show, Switch } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { pipe, sumBy } from "remeda"
import { useTheme } from "@tui/context/theme"
import { useSimulate } from "@tui/context/simulate"
import { SplitBorder } from "@tui/component/border"
import type { AssistantMessage, Session } from "@opencode-ai/sdk/v2"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "../../context/keybind"
import { Installation } from "@/installation"

const Title = (props: { session: Accessor<Session> }) => {
  const { theme } = useTheme()
  return (
    <text fg={theme.text}>
      <span style={{ bold: true }}>#</span> <span style={{ bold: true }}>{props.session().title}</span>
    </text>
  )
}

const ContextInfo = (props: {
  total: Accessor<string | undefined>
  current: Accessor<string | undefined>
  simulatorCurrent: Accessor<string | undefined>
  cost: Accessor<string>
}) => {
  const { theme } = useTheme()
  return (
    <Show when={props.total()}>
      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
        agent_cumulative: {props.total()} | agent_current: {props.current() ?? "0"} {props.cost()}
        <Show when={props.simulatorCurrent()}>
          {" | "}sim_current: {props.simulatorCurrent()}
        </Show>
      </text>
    </Show>
  )
}

export function Header() {
  const route = useRouteData("session")
  const sync = useSync()
  const simulate = useSimulate()
  const session = createMemo(() => sync.session.get(route.sessionID)!)
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])

  const cost = createMemo(() => {
    const total = pipe(
      messages(),
      sumBy((x) => (x.role === "assistant" ? x.cost : 0)),
    )
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const totalTokens = createMemo(() => {
    const total = messages().reduce((sum, msg) => {
      if (msg.role !== "assistant" || !msg.tokens) return sum
      return (
        sum +
        msg.tokens.input +
        msg.tokens.output +
        msg.tokens.reasoning +
        msg.tokens.cache.read +
        msg.tokens.cache.write
      )
    }, 0)
    return total.toLocaleString()
  })

  const currentTokens = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage
    if (!last) return
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    return total.toLocaleString()
  })

  const simulatorCurrentTokens = createMemo(() => {
    if (!simulate.state.active) return
    if (simulate.state.sessionID !== route.sessionID) return
    const total = simulate.state.simulatorCurrentTokens
    if (!total || total <= 0) return
    return total.toLocaleString()
  })

  const { theme } = useTheme()
  const keybind = useKeybind()
  const command = useCommandDialog()
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <Switch>
          <Match when={session()?.parentID}>
            <box flexDirection="row" gap={2}>
              <text fg={theme.text}>
                <b>Subagent session</b>
              </text>
              <box
                onMouseOver={() => setHover("parent")}
                onMouseOut={() => setHover(null)}
                onMouseUp={() => command.trigger("session.parent")}
                backgroundColor={hover() === "parent" ? theme.backgroundElement : theme.backgroundPanel}
              >
                <text fg={theme.text}>
                  Parent <span style={{ fg: theme.textMuted }}>{keybind.print("session_parent")}</span>
                </text>
              </box>
              <box
                onMouseOver={() => setHover("prev")}
                onMouseOut={() => setHover(null)}
                onMouseUp={() => command.trigger("session.child.previous")}
                backgroundColor={hover() === "prev" ? theme.backgroundElement : theme.backgroundPanel}
              >
                <text fg={theme.text}>
                  Prev <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle_reverse")}</span>
                </text>
              </box>
              <box
                onMouseOver={() => setHover("next")}
                onMouseOut={() => setHover(null)}
                onMouseUp={() => command.trigger("session.child.next")}
                backgroundColor={hover() === "next" ? theme.backgroundElement : theme.backgroundPanel}
              >
                <text fg={theme.text}>
                  Next <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle")}</span>
                </text>
              </box>
              <box flexGrow={1} flexShrink={1} />
              <box flexDirection="row" gap={1} flexShrink={0}>
                <ContextInfo
                  total={totalTokens}
                  current={currentTokens}
                  simulatorCurrent={simulatorCurrentTokens}
                  cost={cost}
                />
              </box>
            </box>
          </Match>
          <Match when={true}>
            <box flexDirection="row" justifyContent="space-between" gap={1}>
              <Title session={session} />
              <box flexDirection="row" gap={1} flexShrink={0}>
                <ContextInfo
                  total={totalTokens}
                  current={currentTokens}
                  simulatorCurrent={simulatorCurrentTokens}
                  cost={cost}
                />
              </box>
            </box>
          </Match>
        </Switch>
      </box>
    </box>
  )
}

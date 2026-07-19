import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { GripVertical, MessageSquare, RotateCcw, TerminalSquare, X } from 'lucide-react'
import type { DefaultView, Theme } from '../App'

/** drag props the parent hands down for the header grip (multipane reorder) */
export interface DragHandleProps {
  draggable?: boolean
  onDragStart?: (e: DragEvent) => void
  onDragEnd?: (e: DragEvent) => void
}
import type { Project } from '../lib/api'
import { CelestialSphere } from './CelestialSphere'
import { ChatPanel } from './ChatPanel'
import { TerminalPanel } from './TerminalPanel'
import type { TerminalStatus } from './TerminalPanel'

/**
 * SessionPane — one session's observation floor, self-contained.
 *
 * Extracted from the old monolithic Workspace: a pane owns its OWN sub-view
 * (chat | terminals | agents | brain), its ChatPanel (kept mounted/lit, hidden
 * via `invisible` off-view), and a per-session TerminalPanel POOL with the same
 * keep-alive machinery as before — stable slot keys, the 'new'->minted-id
 * in-place rename, and connection-status tracking. It reports the session ids
 * whose shell is connected upward so the shell (App) can MERGE the live markers
 * across every open pane.
 *
 * Live panels are kept MOUNTED once lit and merely hidden with CSS on sub-view
 * hops — unmounting would dispose the xterm + /ws/terminal socket (killing the
 * server-side pty + running claude CLI) and drop a mid-turn chat stream.
 */

/** counter for generating unique 'new' session keys per pane instance, so that
    multiple new-chat tabs don't collide on the same server-side pty */
let newSessionSeq = 0

/** a pane shows just its session's chat and shell — nothing else */
type PaneView = 'chat' | 'terminals'

interface SubNavDef {
  id: PaneView
  label: string
  icon: typeof MessageSquare
}

const SUB_NAV: SubNavDef[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'terminals', label: 'Terminal', icon: TerminalSquare },
]

export function SessionPane({
  project,
  sessionId,
  theme,
  defaultView,
  viewRequest,
  shellRefresh,
  resizeSignal,
  reconnectAllSignal,
  isFocused,
  onOpenInShell,
  onSessionIdChange,
  onActiveSessionsChange,
  onClose,
  dragHandleProps,
}: {
  project: Project | null
  sessionId: string | null
  theme: Theme
  /** drag-handle props for the header grip — present only when reordering is on */
  dragHandleProps?: DragHandleProps
  /** which sub-view a freshly opened pane lands on (the persisted preference) */
  defaultView: DefaultView
  /** an explicit request (e.g. right-click → "Chat view") to switch the pane
      bound to `sessionId` to a given view; the nonce makes repeats fire */
  viewRequest?: { sessionId: string; view: PaneView; nonce: number } | null
  /** bumps when the shell should re-resume on view (after a chat turn) */
  shellRefresh: number
  /** bumps when this pane's layout changed size (window-count / single↔multi /
      canvas split) — forwarded to the terminal so it refits to the new width */
  resizeSignal: number
  /** bumps from the global "refresh all chats" control — reconnects this pane's
      shell(s) and re-reads its chat log, for every pane (not just the focused
      one), so a reset UI recovers without a full page reload */
  reconnectAllSignal: number
  /** true when this pane is the focused tab — drives the chat/shell `active`
      gating (refetch-on-view, refresh-on-view) so background panes stay put */
  isFocused: boolean
  onOpenInShell?: () => void
  onSessionIdChange?: (sessionId: string) => void
  /** the session ids whose pooled shell is currently connected (live) */
  onActiveSessionsChange?: (ids: string[]) => void
  /** close this window (drop its tab) */
  onClose?: () => void
}) {
  /* stable unique key for THIS pane's 'new' (not-yet-minted) session — each pane
     gets its own so multiple new-chat tabs don't share one server-side pty */
  const newSessionKeyRef = useRef(`new:${newSessionSeq++}`)
  const NEW_SESSION_KEY = newSessionKeyRef.current

  /* this pane's sub-view — seeded from an explicit view request when the pane
     opens to one (right-click → "Chat view"), else the default-view preference */
  const [view, setView] = useState<PaneView>(() =>
    viewRequest && viewRequest.sessionId === (sessionId ?? NEW_SESSION_KEY)
      ? viewRequest.view
      : defaultView,
  )
  /* user-initiated reconnect for the visible shell, hosted in the merged header */
  const [reconnectNonce, setReconnectNonce] = useState(0)

  const liveChat = view === 'chat' && project !== null
  const liveTerminal = view === 'terminals' && project !== null

  /* the session key this pane is pointed at — 'new' until a session is
     selected/minted (matches TerminalPanel's sessionId='new') */
  const currentSessionKey = sessionId ?? NEW_SESSION_KEY

  /* honor a later view request (the on-open one is already seeded above). Every
     pane consumes the nonce so it fires once; only the matching pane switches. */
  const lastViewReqRef = useRef(viewRequest?.nonce ?? 0)
  useEffect(() => {
    if (!viewRequest || viewRequest.nonce === lastViewReqRef.current) return
    lastViewReqRef.current = viewRequest.nonce
    if (viewRequest.sessionId === currentSessionKey) setView(viewRequest.view)
  }, [viewRequest, currentSessionKey])

  /* once the chat panel has been lit it stays mounted (hidden via CSS on other
     sub-views) until the project is deselected */
  const [chatLit, setChatLit] = useState(false)
  useEffect(() => {
    if (liveChat) setChatLit(true)
  }, [liveChat])

  /* — per-session terminal pool (claudecodeui-style): the pane's session keeps
       its OWN xterm + pty alive, hidden (not unmounted) when off-view. A pane is
       bound to one session, so the pool is usually just that session — but the
       pool logic is kept so the 'new'->minted-id rename + keep-alive still work —*/
  const [openedTerminals, setOpenedTerminals] = useState<string[]>([])
  /* stable React key per pooled session slot. When a 'new' session mints a real
     id we rename the slot's session value but reuse the SAME panel key so React
     keeps the original TerminalPanel instance (its xterm + pty socket) instead
     of unmounting it and resuming a second pty from scratch. */
  const slotKeyRef = useRef<Record<string, string>>({})
  const slotSeqRef = useRef(0)
  const slotKeyFor = useCallback((sk: string): string => {
    const existing = slotKeyRef.current[sk]
    if (existing !== undefined) return existing
    const key = `slot-${slotSeqRef.current++}`
    slotKeyRef.current[sk] = key
    return key
  }, [])
  /* the project the pool currently belongs to — a project change must drop the
     stale keys so the next mount never resumes a cross-project pty */
  const poolProjectIdRef = useRef<string | null>(project?.id ?? null)
  useEffect(() => {
    const projectId = project?.id ?? null
    if (projectId !== poolProjectIdRef.current) {
      poolProjectIdRef.current = projectId
      slotKeyRef.current = {}
      if (projectId === null) {
        setChatLit(false)
        setOpenedTerminals([])
        return
      }
      setOpenedTerminals(liveTerminal ? [currentSessionKey] : [])
      return
    }
    if (!liveTerminal) return
    setOpenedTerminals((prev) => {
      if (prev.includes(currentSessionKey)) return prev
      /* a fresh 'new' session just minted a real id (currentSessionKey is now
         that id): replace the 'new' slot in place — carry its stable panel key
         over so the SAME panel/pty survives, rather than leaking the 'new' pty
         and spinning up a duplicate that resumes from scratch */
      if (currentSessionKey !== NEW_SESSION_KEY && prev.includes(NEW_SESSION_KEY)) {
        const carried = slotKeyRef.current[NEW_SESSION_KEY]
        if (carried !== undefined) {
          delete slotKeyRef.current[NEW_SESSION_KEY]
          slotKeyRef.current[currentSessionKey] = carried
        }
        const swapped = prev.map((k) => (k === NEW_SESSION_KEY ? currentSessionKey : k))
        return swapped.filter((k, i) => swapped.indexOf(k) === i)
      }
      return [...prev, currentSessionKey]
    })
  }, [liveTerminal, currentSessionKey, project])

  /* — status of each pooled session key, lifted so a live marker can blink on
       running shells (merged across panes by App) — */
  const [terminalStatus, setTerminalStatus] = useState<Record<string, TerminalStatus>>({})
  const handleStatusChange = useCallback((sk: string, status: TerminalStatus) => {
    setTerminalStatus((prev) => (prev[sk] === status ? prev : { ...prev, [sk]: status }))
  }, [])
  /* prune status for keys no longer pooled (project switch / deselect) */
  useEffect(() => {
    setTerminalStatus((prev) => {
      const next: Record<string, TerminalStatus> = {}
      for (const sk of openedTerminals) {
        if (prev[sk] !== undefined) next[sk] = prev[sk]
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next
    })
  }, [openedTerminals])

  /* report the connected session ids upward (exclude the 'new' key — it has no
     real id yet). Only notify when the id SET changes so a content-identical
     recompute doesn't hand the parent a fresh array and re-render needlessly. */
  const onActiveSessionsChangeRef = useRef(onActiveSessionsChange)
  onActiveSessionsChangeRef.current = onActiveSessionsChange
  const lastActiveSessionsRef = useRef<string>('')
  useEffect(() => {
    const ids = openedTerminals.filter(
      (sk) => !sk.startsWith('new:') && terminalStatus[sk] === 'connected',
    )
    const signature = [...ids].sort().join(',')
    if (signature === lastActiveSessionsRef.current) return
    lastActiveSessionsRef.current = signature
    onActiveSessionsChangeRef.current?.(ids)
  }, [openedTerminals, terminalStatus])

  /* keep "Open in Shell" wired to this pane's own sub-view: the chat surface
     hands the move down here so the SAME session pops into its terminal */
  const handleOpenInShell = useCallback(() => {
    setView('terminals')
    onOpenInShell?.()
  }, [onOpenInShell])

  const shortSession = sessionId !== null ? sessionId.slice(0, 8) : 'NEW'
  const termStatus = terminalStatus[currentSessionKey]

  /* — empty pane: no project/session bound yet — */
  if (project === null) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center px-8 py-10 text-center">
        <div className="relative mb-7 flex items-center justify-center">
          <div
            aria-hidden="true"
            className="absolute h-[min(220px,60vw)] w-[min(220px,60vw)] rounded-full border border-hairline-s"
          />
          <div aria-hidden="true" className="mo-sphere-glow absolute h-[200px] w-[200px]" />
          <CelestialSphere size={180} theme={theme} />
        </div>
        <p className="max-w-xs font-display text-[16px] italic leading-relaxed text-sand">
          An empty plate, unexposed. Select a session and its log opens here.
        </p>
      </div>
    )
  }

  /* the chat's own title (the session summary / custom name), shown first; the
     project name sits beneath it. Kept tight so it survives narrow 5-up panes. */
  const chatName =
    sessionId !== null
      ? (project.sessions ?? []).find((s) => s.id === sessionId)?.summary ||
        `Session ${shortSession}`
      : 'New chat'

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* — single merged header: grip · chat name / project · CHAT|TERMINAL — */}
      <div className="flex items-center gap-1.5 border-b border-hairline bg-midnight-2 px-2 py-1.5">
        {dragHandleProps !== undefined && (
          <button
            type="button"
            aria-label="Drag to rearrange window"
            title="Drag to rearrange"
            className="flex h-6 w-3.5 shrink-0 cursor-grab items-center justify-center text-sand-dim transition-colors duration-200 hover:text-brass active:cursor-grabbing"
            {...dragHandleProps}
          >
            <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[11px] tracking-[0.02em] text-parchment">
            {chatName}
          </div>
          <div className="truncate font-mono text-[9px] uppercase tracking-[0.06em] text-sand-dim">
            {project.name}
          </div>
        </div>
        {/* reconnect ONLY when the shell died — no live/status text in the bar */}
        {view === 'terminals' && (termStatus === 'exited' || termStatus === 'closed') && (
          <button
            type="button"
            onClick={() => setReconnectNonce((n) => n + 1)}
            aria-label="Reconnect terminal"
            className="mo-ticks flex h-6 shrink-0 cursor-pointer items-center gap-1.5 border border-hairline px-2 font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim transition-colors duration-200 hover:border-brass hover:text-brass"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Reconnect
          </button>
        )}
        <nav className="flex shrink-0 items-center gap-1" aria-label="Pane view">
          {SUB_NAV.map(({ id, label, icon: Icon }) => {
            const isActive = view === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                aria-current={isActive ? 'true' : undefined}
                title={label}
                aria-label={label}
                className={`relative flex cursor-pointer items-center gap-1.5 border px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors duration-200 ${
                  isActive
                    ? 'border-brass bg-brass/10 text-brass'
                    : 'border-hairline text-sand hover:border-brass hover:text-brass'
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{label}</span>
              </button>
            )
          })}
        </nav>
        {onClose !== undefined && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close window"
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-sand-dim transition-colors duration-200 hover:text-brass"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* — pane body: persistent live surfaces, hidden (not unmounted) off-view —*/}
      <div className="relative min-h-0 flex-1">
        {/* chat — lit once, kept mounted, hidden when off-view */}
        {chatLit && (
          <section
            aria-label="Chat"
            aria-hidden={liveChat ? undefined : true}
            className={`absolute inset-0 ${liveChat ? '' : 'invisible'}`}
          >
            <ChatPanel
              project={project}
              sessionId={sessionId}
              active={liveChat && isFocused}
              reconnectAllSignal={reconnectAllSignal}
              hideHeader
              onOpenInShell={handleOpenInShell}
            />
          </section>
        )}

        {/* terminal pool — one persistent TerminalPanel per opened session key,
            visible only for the current key, the rest kept alive but hidden
            (visibility, not display — xterm needs dimensions) */}
        {openedTerminals.map((sk) => {
          const isCurrent = sk === currentSessionKey
          const showHere = view === 'terminals' && isCurrent
          return (
            <section
              key={`terminal-${project.id}-${slotKeyFor(sk)}`}
              aria-label="Terminal"
              aria-hidden={showHere ? undefined : true}
              className={`absolute inset-0 ${showHere ? '' : 'invisible'}`}
            >
              <TerminalPanel
                project={project}
                sessionId={sk}
                theme={theme}
                hideHeader
                /* pass the STABLE counters to every panel; the panel gates the
                   re-resume/reconnect on `active` so backgrounded shells aren't
                   restarted. active also requires this pane to be focused — a
                   chat-turn refresh applies to the on-view shell of the focused pane. */
                refreshSignal={shellRefresh}
                reconnectSignal={reconnectNonce}
                reconnectAllSignal={reconnectAllSignal}
                resizeSignal={resizeSignal}
                active={isCurrent && isFocused}
                onStatusChange={(status) => handleStatusChange(sk, status)}
                onSessionIdChange={onSessionIdChange}
              />
            </section>
          )
        })}

      </div>
    </div>
  )
}

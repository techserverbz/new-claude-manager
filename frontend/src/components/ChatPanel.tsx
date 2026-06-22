import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { motion } from 'framer-motion'
import { Square } from 'lucide-react'
import { api } from '../lib/api'
import type { ChatMessage, Project, ToolUse } from '../lib/api'
import { chatSocket } from '../lib/chatSocket'
import type { ChatServerEvent, RawStreamEvent } from '../lib/chatSocket'

/**
 * ChatPanel — the transmission log.
 * History plates (user on surface-2, assistant transparent behind a
 * brass ✦), tool uses as collapsed mono chips, a live streaming turn
 * assembled from raw claude stream-json events, and the input bar
 * pinned at the foot. Work done in the shell flows back in through
 * `sessions-updated` pushes (chokidar on the session JSONL files).
 */

interface StreamContentBlock {
  type?: string
  text?: string
  name?: string
  input?: unknown
}

function contentBlocks(event: RawStreamEvent): StreamContentBlock[] {
  const content = event.message?.content
  if (!Array.isArray(content)) return []
  return content.filter(
    (block): block is StreamContentBlock => block !== null && typeof block === 'object',
  )
}

function ToolChip({ tool }: { tool: ToolUse }) {
  const [open, setOpen] = useState(false)
  const hasInput = tool.input !== undefined && tool.input !== null

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`cursor-pointer border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.22em] transition-colors duration-200 ${
          open ? 'border-brass text-brass' : 'border-hairline text-sand hover:border-brass hover:text-brass'
        }`}
      >
        ⚙ {tool.name}
      </button>
      {open && hasInput && (
        <pre className="mt-2 max-h-48 overflow-auto border border-hairline-s bg-surface-2 p-3 text-left font-mono text-[11px] leading-relaxed text-sand">
          {JSON.stringify(tool.input, null, 2)}
        </pre>
      )}
    </div>
  )
}

function UserPlate({ content }: { content: string }) {
  return (
    <div className="ml-auto max-w-[78%] rounded-[14px] border border-hairline bg-surface-2 px-5 py-4">
      <div className="font-mono text-[9px] uppercase tracking-[0.24em] text-sand-dim">You</div>
      <p className="mt-2 whitespace-pre-wrap font-display text-[15px] leading-relaxed text-parchment">
        {content}
      </p>
    </div>
  )
}

function AssistantPlate({
  content,
  toolUse,
  streaming,
}: {
  content: string
  toolUse?: ToolUse[]
  streaming?: boolean
}) {
  return (
    <div className="flex max-w-[88%] gap-3.5">
      <span aria-hidden="true" className="mt-1 select-none text-brass">
        ✦
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[9px] uppercase tracking-[0.24em] text-sand-dim">
          Christopher
        </div>
        {toolUse !== undefined && toolUse.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-start gap-2">
            {toolUse.map((tool, i) => (
              <ToolChip key={`${tool.name}-${i}`} tool={tool} />
            ))}
          </div>
        )}
        {(content !== '' || streaming === true) && (
          <p className="mt-2 whitespace-pre-wrap font-display text-[15px] leading-relaxed text-parchment">
            {content}
            {streaming === true && (
              <motion.span
                aria-hidden="true"
                className="ml-1 inline-block text-brass"
                animate={{ opacity: [0.2, 1, 0.2] }}
                transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
              >
                ▍
              </motion.span>
            )}
          </p>
        )}
      </div>
    </div>
  )
}

export function ChatPanel({
  project,
  sessionId,
  active = true,
  reconnectAllSignal = 0,
  hideHeader = false,
  onOpenInShell,
  onSessionIdChange,
}: {
  project: Project
  sessionId: string | null
  /** true while the chat tab is the visible one — drives refetch-on-view so
      messages written by the shell (a separate process) appear when you return */
  active?: boolean
  /** bump from the global "refresh all chats" control — re-reads this chat's
      history (skipping mid-stream) so a stale log refreshes without a page reload */
  reconnectAllSignal?: number
  /** when true the panel renders only the log + input (no header) — the parent
      pane shows a single merged header instead */
  hideHeader?: boolean
  onOpenInShell?: () => void
  /** lifts the authoritative session id (from `done`) up to App state */
  onSessionIdChange?: (sessionId: string) => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [committedText, setCommittedText] = useState('')
  const [deltaText, setDeltaText] = useState('')
  const [liveTools, setLiveTools] = useState<ToolUse[]>([])
  const [error, setError] = useState<string | null>(null)

  const streamingRef = useRef(false)
  const projectIdRef = useRef(project.id)
  const sessionIdRef = useRef(sessionId)
  const scrollRef = useRef<HTMLDivElement>(null)
  /* when set, the next messages render scrolls to the TOP (not the foot) — used
     on open / becoming visible so a chat view always opens at the start. */
  const scrollTopPendingRef = useRef(false)
  /* the live turn mirrored into refs: WS events can arrive faster than
     React re-renders, so the `done` fallback must not read render-scope
     state (it would miss the last delta(s)/tool uses) */
  const committedRef = useRef('')
  const deltaRef = useRef('')
  const toolsRef = useRef<ToolUse[]>([])

  projectIdRef.current = project.id
  /* never clobber a session id learned mid-stream (system/session-created/
     done events) with a stale prop while a turn is in flight */
  if (!streamingRef.current) sessionIdRef.current = sessionId

  const setStreaming = (value: boolean) => {
    streamingRef.current = value
    setIsStreaming(value)
  }

  const clearLiveTurn = () => {
    committedRef.current = ''
    deltaRef.current = ''
    toolsRef.current = []
    setCommittedText('')
    setDeltaText('')
    setLiveTools([])
  }

  const loadMessages = useCallback(
    async (sid: string) => {
      try {
        const fetched = await api.getMessages(project.id, sid)
        setMessages(fetched)
        return true
      } catch {
        return false
      }
    },
    [project.id],
  )

  /* — history fetch on session change (skipped mid-stream: the id
       arriving via session-created must not clobber the live turn) — */
  useEffect(() => {
    if (streamingRef.current) return
    setError(null)
    if (sessionId === null) {
      setMessages([])
      return
    }
    /* a different chat just opened here — show it from the top */
    scrollTopPendingRef.current = true
    let cancelled = false
    api
      .getMessages(project.id, sessionId)
      .then((fetched) => {
        if (!cancelled) setMessages(fetched)
      })
      .catch(() => {
        if (!cancelled) setError('Could not read the session log.')
      })
    return () => {
      cancelled = true
    }
  }, [project.id, sessionId])

  /* — refetch on becoming the visible tab: a shell turn (separate process)
       may have appended messages while we were hidden; the chokidar push can
       lag or be missed, so re-read the log whenever the chat is shown — */
  const wasActiveRef = useRef(false)
  useEffect(() => {
    const becameActive = active && !wasActiveRef.current
    wasActiveRef.current = active
    if (becameActive && sessionId !== null && !streamingRef.current) {
      /* the chat view just came on screen — open it at the top */
      scrollTopPendingRef.current = true
      void loadMessages(sessionId)
    }
  }, [active, sessionId, loadMessages])

  /* — global "refresh all chats": re-read this chat's log on demand (every
       mounted ChatPanel, not just the visible one), skipping mid-stream so a
       live turn isn't clobbered. Stable shared counter; only an increase acts. */
  const lastReconnectAllRef = useRef(reconnectAllSignal)
  useEffect(() => {
    const prev = lastReconnectAllRef.current
    lastReconnectAllRef.current = reconnectAllSignal
    if (reconnectAllSignal <= prev) return
    if (sessionId !== null && !streamingRef.current) void loadMessages(sessionId)
  }, [reconnectAllSignal, sessionId, loadMessages])

  /* belt-and-suspenders: while the chat is the visible tab and idle, re-read
     the log on a short interval. The interactive shell holds the session
     JSONL open and may write a turn just after an on-view refetch (or a
     watcher push may lag), so a steady poll guarantees shell turns surface
     within a couple seconds without the user having to do anything. */
  useEffect(() => {
    if (!active || sessionId === null) return
    const id = window.setInterval(() => {
      if (!streamingRef.current) void loadMessages(sessionId)
    }, 2500)
    return () => window.clearInterval(id)
  }, [active, sessionId, loadMessages])

  /* — chat socket events (stable subscription, fresh handler via ref) — */
  const handlerRef = useRef<((ev: ChatServerEvent) => void) | null>(null)
  handlerRef.current = (ev: ChatServerEvent) => {
    switch (ev.type) {
      case 'session-created': {
        if (streamingRef.current) sessionIdRef.current = ev.sessionId
        break
      }
      case 'stream': {
        if (!streamingRef.current) break
        const raw = ev.event
        if (raw.type === 'system') {
          if (typeof raw.session_id === 'string') sessionIdRef.current = raw.session_id
          break
        }
        if (raw.type === 'stream_event') {
          const inner = raw.event
          if (
            inner !== undefined &&
            inner.type === 'content_block_delta' &&
            inner.delta !== undefined &&
            inner.delta.type === 'text_delta' &&
            typeof inner.delta.text === 'string'
          ) {
            deltaRef.current += inner.delta.text
            setDeltaText(deltaRef.current)
          }
          break
        }
        if (raw.type === 'assistant') {
          /* a complete assistant message supersedes any partial deltas */
          deltaRef.current = ''
          setDeltaText('')
          for (const block of contentBlocks(raw)) {
            if (block.type === 'text' && typeof block.text === 'string') {
              const text = block.text
              committedRef.current =
                committedRef.current === '' ? text : `${committedRef.current}\n\n${text}`
              setCommittedText(committedRef.current)
            } else if (block.type === 'tool_use' && typeof block.name === 'string') {
              const tool: ToolUse = { name: block.name, input: block.input }
              toolsRef.current = [...toolsRef.current, tool]
              setLiveTools(toolsRef.current)
            }
          }
        }
        break
      }
      case 'done': {
        const sid = ev.sessionId
        if (!streamingRef.current) {
          /* the turn outlived a panel remount (e.g. a hop through another
             project mid-stream) — refresh history if it is our session */
          if (sid !== null && (sessionIdRef.current === null || sessionIdRef.current === sid)) {
            sessionIdRef.current = sid
            onSessionIdChange?.(sid)
            void loadMessages(sid)
          }
          break
        }
        if (sid !== null) {
          sessionIdRef.current = sid
          /* lift the authoritative id so the next send + Open in Shell
             resume the REAL session (resume can mint a new id) */
          onSessionIdChange?.(sid)
        }
        void (async () => {
          /* sid === null: a fresh turn died pre-handshake — no transcript
             on disk to fetch, go straight to the local fallback */
          const ok = sid !== null ? await loadMessages(sid) : false
          if (!ok) {
            /* fall back to the assembled live turn, read from the refs —
               render-scope state may be missing the final delta(s) */
            const assembled =
              committedRef.current +
              (deltaRef.current !== ''
                ? (committedRef.current !== '' ? '\n\n' : '') + deltaRef.current
                : '')
            const tools = toolsRef.current
            setMessages((prev) => {
              if (assembled === '' && tools.length === 0) return prev
              return [
                ...prev,
                {
                  id: `local-assistant-${Date.now()}`,
                  role: 'assistant',
                  content: assembled,
                  timestamp: new Date().toISOString(),
                  toolUse: tools.length > 0 ? tools : undefined,
                },
              ]
            })
          }
          clearLiveTurn()
          setStreaming(false)
        })()
        break
      }
      case 'error': {
        if (streamingRef.current) {
          setError(ev.error)
          clearLiveTurn()
          setStreaming(false)
        }
        break
      }
      case 'sessions-updated': {
        /* shell wrote the session JSONL — refresh the log unless we
           are mid-stream ourselves */
        if (
          ev.projectId === projectIdRef.current &&
          !streamingRef.current &&
          sessionIdRef.current !== null
        ) {
          void loadMessages(sessionIdRef.current)
        }
        break
      }
    }
  }

  useEffect(() => {
    return chatSocket.subscribe((ev) => handlerRef.current?.(ev))
  }, [])

  /* — scroll: open at the TOP on first load/visibility, else follow the foot — */
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    if (scrollTopPendingRef.current) {
      scrollTopPendingRef.current = false
      el.scrollTop = 0
      return
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [messages, committedText, deltaText, liveTools, isStreaming])

  const handleSend = () => {
    const text = input.trim()
    if (text === '' || isStreaming) return
    setError(null)
    setMessages((prev) => [
      ...prev,
      {
        id: `local-user-${Date.now()}`,
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
      },
    ])
    setInput('')
    clearLiveTurn()
    setStreaming(true)
    /* prefer the prop, but fall back to the id learned from the stream —
       App may not have received a dedicated session-created event */
    const sid = sessionId ?? sessionIdRef.current
    sessionIdRef.current = sid
    chatSocket.sendChat(project.id, sid, text)
  }

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const liveText = committedText + (deltaText !== '' ? (committedText !== '' ? '\n\n' : '') + deltaText : '')
  const shortSession = sessionId !== null ? sessionId.slice(0, 8) : 'NEW'
  const isEmpty = messages.length === 0 && !isStreaming

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* — panel header (suppressed when the pane shows a merged header) — */}
      {!hideHeader && (
        <div className="flex items-center justify-between gap-4 border-b border-hairline px-6 py-3">
          <div className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.22em] text-sand">
            <span className="text-brass" aria-hidden="true">
              ✦
            </span>{' '}
            Transmission · {project.name} · Session {shortSession}
          </div>
          <button
            type="button"
            onClick={onOpenInShell}
            className="mo-button shrink-0 px-4! py-2!"
          >
            Open in Shell →
          </button>
        </div>
      )}

      {/* — message log — */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <span aria-hidden="true" className="text-brass">
              ✦
            </span>
            <p className="mt-4 max-w-sm font-display text-[17px] italic leading-relaxed text-sand">
              {sessionId === null
                ? 'A fresh plate, unexposed. Transmit your first line and the almanac will keep the record.'
                : 'This session holds no transmissions yet.'}
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            {messages.map((m) =>
              m.role === 'user' ? (
                <UserPlate key={m.id} content={m.content} />
              ) : (
                <AssistantPlate key={m.id} content={m.content} toolUse={m.toolUse} />
              ),
            )}
            {isStreaming && (
              <AssistantPlate content={liveText} toolUse={liveTools} streaming />
            )}
          </div>
        )}
      </div>

      {/* — inline error — */}
      {error !== null && (
        <div className="px-6 pb-2">
          <p
            role="alert"
            className="mx-auto max-w-3xl border border-brass px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-brass"
          >
            {error}
          </p>
        </div>
      )}

      {/* — input bar, pinned at the foot — */}
      <div className="border-t border-hairline bg-surface px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-end gap-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder="Transmit to Christopher… (Enter sends · Shift+Enter for a new line)"
            aria-label="Message"
            className="min-h-[56px] flex-1 resize-none border border-hairline bg-transparent px-4 py-3 font-display text-[15px] leading-relaxed text-parchment placeholder:text-sand-dim transition-colors duration-200 focus:border-brass"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={() => chatSocket.sendAbort()}
              aria-label="Abort transmission"
              className="mo-ticks flex h-[56px] w-[56px] shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
            >
              <Square className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={input.trim() === ''}
              className="mo-button shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Transmit
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

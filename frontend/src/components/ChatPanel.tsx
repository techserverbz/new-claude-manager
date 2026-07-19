import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { ChatMessage, Project, ToolUse } from '../lib/api'
import { chatSocket } from '../lib/chatSocket'
import type { ChatServerEvent } from '../lib/chatSocket'

/**
 * ChatPanel — the transmission log, now a READ-ONLY message viewer.
 *
 * There is exactly ONE claude per session: the interactive pty (the terminal
 * view). This panel never spawns a claude of its own — it renders the session's
 * transcript by reading the session JSONL that the terminal's claude writes, and
 * live-updates by re-reading it whenever the shell appends (a `sessions-updated`
 * push from the chokidar watcher, plus an on-view refetch and a steady poll as
 * backstops). This is the 26-engine model: the terminal drives, the log reflects.
 * Removing the old per-message `claude --print` spawn is what makes the app
 * non-terminating no matter how many windows are open.
 */

/** Whether two fetched histories are the same (id + text + tool count). Lets an
    idle poll keep the SAME array reference so React skips the re-render — a churned
    list otherwise disturbs the user's scroll position mid-read. */
function sameMessages(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false
    if (a[i].content !== b[i].content) return false
    if ((a[i].toolUse?.length ?? 0) !== (b[i].toolUse?.length ?? 0)) return false
  }
  return true
}

/** Whether `next` is a strict PREFIX of `prev` (same ids, fewer of them). That is
    the exact signature of a torn read — the shell appended a line the server read
    mid-write, so parseLines dropped the trailing message and the count came back
    one short. We ignore such a background refetch so the history never flickers
    N↔N-1. A genuine in-place shrink (compaction) changes the HEAD, not a clean
    prefix, so it is NOT caught here; a real session switch replaces the list via
    the session-change effect, which bypasses this guard entirely. */
function isTornPrefix(prev: ChatMessage[], next: ChatMessage[]): boolean {
  if (next.length >= prev.length) return false
  // an empty read while we already hold messages is a fully-torn/truncated read
  // (session JSONL is append-only, so it never legitimately empties in place)
  if (next.length === 0) return true
  for (let i = 0; i < next.length; i++) {
    if (next[i].id !== prev[i].id) return false
  }
  return true
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

function AssistantPlate({ content, toolUse }: { content: string; toolUse?: ToolUse[] }) {
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
        {content !== '' && (
          <p className="mt-2 whitespace-pre-wrap font-display text-[15px] leading-relaxed text-parchment">
            {content}
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
}: {
  project: Project
  sessionId: string | null
  /** true while this log is the visible view — drives refetch-on-view so
      messages written by the shell appear when you return to it */
  active?: boolean
  /** bump from the global "refresh all chats" control — re-reads this log's
      history so a stale view refreshes without a page reload */
  reconnectAllSignal?: number
  /** when true the panel renders only the log (no header) — the parent pane
      shows a single merged header instead */
  hideHeader?: boolean
  onOpenInShell?: () => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [error, setError] = useState<string | null>(null)

  const projectIdRef = useRef(project.id)
  const sessionIdRef = useRef(sessionId)
  const scrollRef = useRef<HTMLDivElement>(null)
  /* when set, the next messages render jumps to the FOOT (latest) — used on open /
     becoming visible so the log always opens on the most recent message (you then
     scroll UP for history). */
  const scrollBottomPendingRef = useRef(false)
  /* whether the user is parked at the foot. Updated from real scroll events (not
     recomputed per render), so auto-follow only happens when they're already at
     the bottom — scrolling up to read is never yanked back down. */
  const pinnedToBottomRef = useRef(true)

  projectIdRef.current = project.id
  sessionIdRef.current = sessionId

  const loadMessages = useCallback(
    async (sid: string) => {
      try {
        const fetched = await api.getMessages(project.id, sid)
        /* a session switch happened while this fetch was in flight — drop the
           stale result so two fetchers on different ids can't alternate histories */
        if (sessionIdRef.current !== sid) return false
        setMessages((prev) => {
          /* keep the same array (skip the re-render) when nothing changed, so the
             steady poll never jostles the scroll position while you're reading */
          if (sameMessages(prev, fetched)) return prev
          /* a background refetch that came back a strict prefix is a torn read
             (the shell was mid-append) — ignore it so the last message never
             flickers out and back, jolting the scroll. Real growth / content
             changes / a genuine non-prefix shrink still flow through. */
          if (isTornPrefix(prev, fetched)) return prev
          return fetched
        })
        return true
      } catch {
        return false
      }
    },
    [project.id],
  )

  /* — history fetch on session change — */
  useEffect(() => {
    setError(null)
    if (sessionId === null) {
      setMessages([])
      return
    }
    /* a different session just opened here — land on its latest message */
    scrollBottomPendingRef.current = true
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

  /* — refetch on becoming the visible view: a shell turn may have appended
       messages while we were hidden; the chokidar push can lag or be missed,
       so re-read the log whenever this view is shown — */
  const wasActiveRef = useRef(false)
  useEffect(() => {
    const becameActive = active && !wasActiveRef.current
    wasActiveRef.current = active
    if (becameActive && sessionId !== null) {
      /* the log just came on screen — land on its latest message */
      scrollBottomPendingRef.current = true
      void loadMessages(sessionId)
    }
  }, [active, sessionId, loadMessages])

  /* — global "refresh all chats": re-read this log on demand (every mounted
       panel, not just the visible one). Stable shared counter; only an increase acts. */
  const lastReconnectAllRef = useRef(reconnectAllSignal)
  useEffect(() => {
    const prev = lastReconnectAllRef.current
    lastReconnectAllRef.current = reconnectAllSignal
    if (reconnectAllSignal <= prev) return
    if (sessionId !== null) void loadMessages(sessionId)
  }, [reconnectAllSignal, sessionId, loadMessages])

  /* belt-and-suspenders: while this log is the visible view, re-read it on a
     short interval. The interactive shell holds the session JSONL open and may
     write a turn just after an on-view refetch (or a watcher push may lag), so a
     steady poll guarantees shell turns surface within a couple seconds. */
  useEffect(() => {
    if (!active || sessionId === null) return
    const id = window.setInterval(() => {
      /* read the live id from the ref — the same source the sessions-updated
         watcher uses — so a stale prop in this closure can't make the poll fetch
         a different session and alternate two histories */
      const sid = sessionIdRef.current
      if (sid !== null) void loadMessages(sid)
    }, 2500)
    return () => window.clearInterval(id)
  }, [active, sessionId, loadMessages])

  /* — chat socket events (stable subscription, fresh handler via ref). The
       socket is read-only now; the only event we act on is `sessions-updated`,
       which the JSONL watcher emits when the shell appends to a session. — */
  const handlerRef = useRef<((ev: ChatServerEvent) => void) | null>(null)
  handlerRef.current = (ev: ChatServerEvent) => {
    if (
      ev.type === 'sessions-updated' &&
      ev.projectId === projectIdRef.current &&
      sessionIdRef.current !== null
    ) {
      void loadMessages(sessionIdRef.current)
    }
  }

  useEffect(() => {
    return chatSocket.subscribe((ev) => handlerRef.current?.(ev))
  }, [])

  /* — track whether the user is parked at the foot, from REAL scroll events.
       This drives auto-follow: while pinned, new messages keep the view at the
       latest; once they scroll up, we leave them alone (no yank-back). — */
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const onScroll = () => {
      pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  /* — scroll: open on the latest message (foot) on first load / becoming visible /
       session change; otherwise follow the foot only while the user is pinned
       there. Scrolling up to read history is never interrupted. — */
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    if (scrollBottomPendingRef.current) {
      scrollBottomPendingRef.current = false
      pinnedToBottomRef.current = true
      el.scrollTop = el.scrollHeight
      /* a late layout pass (font/wrap settle) can grow the height a frame later */
      requestAnimationFrame(() => {
        const e2 = scrollRef.current
        if (e2 !== null) e2.scrollTop = e2.scrollHeight
      })
      return
    }
    if (pinnedToBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const shortSession = sessionId !== null ? sessionId.slice(0, 8) : 'NEW'
  const isEmpty = messages.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* — panel header (suppressed when the pane shows a merged header) — */}
      {!hideHeader && (
        <div className="flex items-center justify-between gap-4 border-b border-hairline px-6 py-3">
          <div className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.22em] text-sand">
            <span className="text-brass" aria-hidden="true">
              ✦
            </span>{' '}
            Log · {project.name} · Session {shortSession}
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

      {/* — message log (read-only) — */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <span aria-hidden="true" className="text-brass">
              ✦
            </span>
            <p className="mt-4 max-w-sm font-display text-[17px] italic leading-relaxed text-sand">
              {sessionId === null
                ? 'A fresh plate, unexposed. Open the shell and begin — the almanac keeps the record here.'
                : 'This session holds no transmissions yet. Work in the shell and the log appears here.'}
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
          </div>
        )}
      </div>

      {/* — inline error — */}
      {error !== null && (
        <div className="px-6 pb-4">
          <p
            role="alert"
            className="mx-auto max-w-3xl border border-brass px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-brass"
          >
            {error}
          </p>
        </div>
      )}
    </div>
  )
}

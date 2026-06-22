import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ClipboardPaste, Copy, RotateCcw, Scissors } from 'lucide-react'
import type { Project } from '../lib/api'
import type { Theme } from '../App'
import '@xterm/xterm/css/xterm.css'

/**
 * TerminalPanel — the instrument console.
 * An xterm bound to /ws/terminal?projectId=..&sessionId=<id|new>;
 * the server runs the claude CLI in a node-pty cwd'd at the project's
 * fileDir (resuming the session when one is selected). Theme colors
 * are read live from the observatory CSS tokens so the console swaps
 * paper with the rest of the app.
 *
 * The glyph grid uses a monospace stack — the sanctioned exception to
 * the strict Space Grotesk system: xterm measures a fixed cell width,
 * and a proportional face would shear the grid. The stack leads with
 * faces that exist on Windows (Cascadia, Consolas) so it never falls
 * to Courier New.
 *
 * The session binding is captured ONCE per connection: a sessionId
 * prop change must not tear down a live pty mid-use (e.g. when
 * session-created lands while a fresh chat is streaming). Reconnect
 * picks up the latest id.
 */

const TERMINAL_INIT_DELAY_MS = 100
const TERMINAL_RESIZE_DELAY_MS = 50

/* Mouse-tracking sanitization. The claude TUI enables xterm mouse tracking
   (DECSET ?1000/?1002/?1003 + ?1006 encoding). xterm 6's mousedown gate is
   `!areMouseEventsActive || shouldForceSelection(ev)`, so with mouse tracking on
   a plain left drag is handed to the app instead of forming a text selection —
   nothing highlights, term.getSelection() is empty, and right-click Copy has
   nothing to copy. Stripping these private modes from the output stream keeps
   xterm's mouse protocol at NONE, so a normal drag selects text and Copy works.
   Only the mouse modes below are removed; alt-screen (?1049), bracketed paste
   (?2004), cursor visibility (?25) etc. pass through untouched. (Manager 26 used
   the same stream-sanitization pattern — it stripped alt-screen — which is why
   selection worked there before xterm 6 / the newer claude TUI.) */
const MOUSE_PRIVATE_MODES = new Set([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015])
/* any private-mode set: ESC [ ? <params> (h|l) — params may batch several modes */
const PRIVATE_MODE_SET_RE = /\x1b\[\?([\d;]+)([hl])/g
/* a trailing INCOMPLETE CSI (ESC, ESC[, ESC[?, ESC[<params>, ESC[?<params>) — held
   back across WS frames so a mouse sequence ConPTY split mid-CSI can't slip the
   filter. Checked only over the tail (mouse sets are short), so a longer non-mouse
   CSI that isn't carried is harmless: xterm reassembles partial writes itself. */
const CSI_TAIL_RE = /\x1b(?:\[\??[\d;]*)?$/
const CSI_TAIL_WINDOW = 64

/** Drop claude's mouse-tracking modes from a chunk, preserving any non-mouse
    private modes batched into the same sequence. */
function stripMouseTracking(s: string): string {
  return s.replace(PRIVATE_MODE_SET_RE, (_full, params: string, hl: string) => {
    const kept = params.split(';').filter((p) => p !== '' && !MOUSE_PRIVATE_MODES.has(Number(p)))
    return kept.length > 0 ? `\x1b[?${kept.join(';')}${hl}` : ''
  })
}

function readToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value !== '' ? value : fallback
}

/** midnight bg / parchment fg / brass cursor, straight from the tokens */
function readTerminalTheme(): ITheme {
  const background = readToken('--p-bg', '#0a0a0a')
  const foreground = readToken('--p-text', '#e8dcc0')
  const brass = readToken('--p-accent', '#d4a437')
  return {
    background,
    foreground,
    cursor: brass,
    cursorAccent: background,
    selectionBackground: readToken('--p-glow', 'rgba(212, 164, 55, 0.14)'),
  }
}

export type TerminalStatus = 'connecting' | 'connected' | 'exited' | 'closed'

export function TerminalPanel({
  project,
  sessionId,
  theme,
  refreshSignal = 0,
  reconnectSignal = 0,
  reconnectAllSignal = 0,
  resizeSignal = 0,
  active = true,
  hideHeader = false,
  onStatusChange,
}: {
  project: Project
  sessionId: string | null
  theme: Theme
  /** bump to force a re-resume — used by "refresh shell on view" after a chat
      turn appended messages the running pty hasn't loaded. This is a STABLE,
      shared counter; only the `active` panel acts on an increment */
  refreshSignal?: number
  /** bump to reconnect (revive an exited/dropped shell) — STABLE shared counter,
      only the `active` panel acts. Lets a parent header host the Reconnect */
  reconnectSignal?: number
  /** bump to reconnect EVERY mounted panel (the global "refresh all chats"
      control) — unlike reconnectSignal this is NOT gated on `active`, so
      backgrounded shells revive too. The server keeps the pty alive and
      replays its buffer, so a reconnect restores the live screen. */
  reconnectAllSignal?: number
  /** bump to force a refit (fit addon + pty resize) after the pane's layout
      changed size (window-count / single↔multi / canvas split). A refit never
      tears anything down, so EVERY mounted panel honors it regardless of
      `active` — they all resized when the layout did. */
  resizeSignal?: number
  /** whether this panel is the one currently on view — only an active panel
      honors a refresh/reconnect bump, so backgrounded shells are never torn down */
  active?: boolean
  /** when true the panel renders only the console (no instrument strip) — the
      parent pane shows a single merged header instead */
  hideHeader?: boolean
  /** notified whenever this panel's connection status changes (and 'closed' on
      unmount), so the workspace can light a live marker for running shells */
  onStatusChange?: (status: TerminalStatus) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  /* set by the lifecycle effect — refit the grid to the container and tell the
     pty the new size. Called by the ResizeObserver AND an external resizeSignal
     bump (the latter for layout changes the observer's debounce can miss). */
  const refitRef = useRef<(() => void) | null>(null)
  const [status, setStatus] = useState<TerminalStatus>('connecting')
  /* status mirrored to a ref so the reconnect-all effect can read it without
     re-subscribing — used to SKIP reviving a deliberately-exited shell */
  const statusRef = useRef(status)
  statusRef.current = status
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [connectNonce, setConnectNonce] = useState(0)
  /* the live socket, mirrored to a ref so the right-click menu's Paste (which
     runs in render scope, outside the lifecycle effect) can write to the pty */
  const wsRef = useRef<WebSocket | null>(null)
  /* terminal right-click menu — anchored at the click point. `hasSelection` is
     captured when the menu opens so Copy/Cut can be greyed out with nothing
     selected. null = closed. */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(
    null,
  )
  const ctxMenuRef = useRef<HTMLDivElement | null>(null)

  /* latest prop, read once at connect time — a prop change must NOT
     remount/kill a live pty (the connection keeps its original binding) */
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId

  /* when the next connection should ask the server to drop the stale pty and
     re-resume (set by the refreshSignal effect below, consumed at connect) */
  const forceRestartRef = useRef(false)
  /* set by the reconnect-all effect: the next connect should REJOIN the pty this
     panel is already bound to (connectedSidRef) rather than re-resume under the
     latest prop id. Consumed at connect. */
  const rejoinBoundRef = useRef(false)
  /* the session id (null for a 'new' session) the CURRENT live connection used.
     A plain reconnect rejoins this SAME server key instead of one derived from a
     newer prop id — otherwise a 'new'→real migration (which keeps the socket but
     bumps the prop) would resume a fresh pty under the real id, orphaning the
     live 'new' pty and spawning a duplicate claude. undefined until first connect. */
  const connectedSidRef = useRef<string | null | undefined>(undefined)
  const lastRefreshRef = useRef(refreshSignal)
  const activeRef = useRef(active)
  activeRef.current = active
  useEffect(() => {
    const prev = lastRefreshRef.current
    /* always advance the watermark so a later increment is measured from the
       value we last saw — a swallowed (non-active) bump never re-fires */
    lastRefreshRef.current = refreshSignal
    /* `refreshSignal` is a STABLE shared counter, never reset on visibility.
       Only a strict increase is a genuine "re-resume now" request, and only the
       panel currently on view should act on it — a backgrounded shell must keep
       its terminal state rather than tear down and re-resume from scratch. */
    if (refreshSignal <= prev) return
    if (!activeRef.current) return
    forceRestartRef.current = true
    setConnectNonce((n) => n + 1)
  }, [refreshSignal])
  /* explicit reconnect (parent-hosted Reconnect button) — plain reconnect, no
     forceRestart: revive the session's pty (or re-resume if it died) */
  const lastReconnectRef = useRef(reconnectSignal)
  useEffect(() => {
    const prev = lastReconnectRef.current
    lastReconnectRef.current = reconnectSignal
    if (reconnectSignal <= prev) return
    if (!activeRef.current) return
    setConnectNonce((n) => n + 1)
  }, [reconnectSignal])
  /* global "refresh all chats" — reconnect REGARDLESS of `active` so every
     mounted shell (including backgrounded panes) re-establishes its socket and
     replays the server's buffer. The lifecycle effect's cleanup tears down the
     old socket/term first, so this never leaks a connection. */
  const lastReconnectAllRef = useRef(reconnectAllSignal)
  useEffect(() => {
    const prev = lastReconnectAllRef.current
    lastReconnectAllRef.current = reconnectAllSignal
    if (reconnectAllSignal <= prev) return
    /* don't revive a shell the user deliberately let die / Terminated — refresh
       recovers dropped/stale links, it must not respawn an exited claude */
    if (statusRef.current === 'exited') return
    /* rejoin the pty we're already bound to (no re-resume under a newer id) */
    rejoinBoundRef.current = true
    setConnectNonce((n) => n + 1)
  }, [reconnectAllSignal])
  /* refit when the pane's layout changed size (window-count / single↔multi /
     canvas split). The ResizeObserver usually catches this, but a fast reflow
     can settle inside its debounce and leave the grid at the old size — so refit
     explicitly, twice, to catch the immediate change AND the post-scrollbar
     settle. Idempotent when nothing actually changed; NO `active` gate — a refit
     tears nothing down, and every mounted panel resized when the layout did. */
  const lastResizeRef = useRef(resizeSignal)
  useEffect(() => {
    if (resizeSignal === lastResizeRef.current) return
    lastResizeRef.current = resizeSignal
    const t1 = window.setTimeout(() => refitRef.current?.(), 80)
    const t2 = window.setTimeout(() => refitRef.current?.(), 300)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [resizeSignal])
  /* the id this connection actually resumed, for the header strip */
  const [boundSessionId, setBoundSessionId] = useState<string | null>(sessionId)

  /* — terminal + socket lifecycle, keyed to the project + reconnects — */
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return

    const sid = sessionIdRef.current
    setBoundSessionId(sid)
    setStatus('connecting')
    setExitCode(null)

    let disposed = false
    let ws: WebSocket | null = null

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily:
        '"Cascadia Mono", "Cascadia Code", Consolas, "JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
      allowProposedApi: true,
      convertEol: true,
      scrollback: 10000,
      tabStopWidth: 4,
      theme: readTerminalTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term

    const sendResize = () => {
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    /* refit the grid to the container, then tell the pty the new dimensions.
       Shared by the ResizeObserver and the external resizeSignal bump. */
    refitRef.current = () => {
      if (disposed) return
      try {
        fit.fit()
      } catch {
        /* container may be mid-layout */
      }
      sendResize()
    }

    /* per-connection partial-sequence carry for the mouse-tracking strip. ConPTY
       can split a CSI across two WS frames, so a trailing incomplete CSI is held
       and prepended to the next chunk before stripping; an orphaned carry is
       flushed after 50ms so a lone ESC is never swallowed. Reset per effect run
       (one terminal instance == one socket). */
    let mouseCarry = ''
    let mouseFlushTimer: number | undefined
    const writeSanitized = (data: string) => {
      window.clearTimeout(mouseFlushTimer)
      let text = stripMouseTracking(mouseCarry + data)
      mouseCarry = ''
      const from = Math.max(0, text.length - CSI_TAIL_WINDOW)
      const tail = text.slice(from).match(CSI_TAIL_RE)
      if (tail !== null && tail[0] !== '') {
        mouseCarry = tail[0]
        text = text.slice(0, text.length - tail[0].length)
        mouseFlushTimer = window.setTimeout(() => {
          if (mouseCarry !== '') {
            term.write(mouseCarry)
            mouseCarry = ''
          }
        }, 50)
      }
      if (text !== '') term.write(text)
    }

    /* the connect is deferred a tick so StrictMode's probe mount never
       opens a socket (which would spawn-and-kill a stray server pty,
       minting a junk session JSONL when sessionId=new) */
    const connectTimer = window.setTimeout(() => {
      if (disposed) return
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      /* consume the one-shot force flag: this reconnect re-resumes from scratch */
      const force = forceRestartRef.current
      forceRestartRef.current = false
      /* consume the one-shot rejoin flag: a reconnect-all rejoins the SAME pty
         this panel is bound to (connectedSidRef) instead of resuming under the
         latest prop id — avoids orphaning the live pty + duplicating claude when
         a 'new' session migrated to a real id without remounting. A forced
         re-resume or the first connect uses the latest id (`sid`). */
      const rejoin = rejoinBoundRef.current
      rejoinBoundRef.current = false
      const connectSid =
        rejoin && !force && connectedSidRef.current !== undefined ? connectedSidRef.current : sid
      connectedSidRef.current = connectSid
      if (connectSid !== sid) setBoundSessionId(connectSid)
      const query = `projectId=${encodeURIComponent(project.id)}&sessionId=${encodeURIComponent(
        connectSid ?? 'new',
      )}${force ? '&forceRestart=1' : ''}`
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws/terminal?${query}`)
      ws = socket
      wsRef.current = socket

      socket.onopen = () => {
        if (disposed) return
        setStatus('connected')
        window.setTimeout(() => {
          if (disposed) return
          try {
            fit.fit()
          } catch {
            /* container may be mid-layout */
          }
          sendResize()
          term.focus()
        }, TERMINAL_INIT_DELAY_MS)
      }

      socket.onmessage = (e: MessageEvent) => {
        if (disposed) return
        let msg: unknown
        try {
          msg = JSON.parse(String(e.data))
        } catch {
          return
        }
        if (msg === null || typeof msg !== 'object') return
        const parsed = msg as { type?: string; data?: unknown; code?: unknown }
        if (parsed.type === 'output' && typeof parsed.data === 'string') {
          writeSanitized(parsed.data)
        } else if (parsed.type === 'exit') {
          setStatus('exited')
          setExitCode(typeof parsed.code === 'number' ? parsed.code : null)
        }
      }

      socket.onclose = () => {
        if (disposed) return
        setStatus((s) => (s === 'exited' ? s : 'closed'))
      }
    }, 0)

    const dataSub = term.onData((data) => {
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })

    /* right-click menu — suppress the browser's native menu (its Copy can't see
       xterm's own selection model) and open our Copy/Cut/Paste menu instead. The
       selection it copies is now possible because writeSanitized keeps xterm out
       of mouse-tracking mode; the actions run from render scope (handleCopy etc). */
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      setCtxMenu({ x: e.clientX, y: e.clientY, hasSelection: term.hasSelection() })
    }
    container.addEventListener('contextmenu', handleContextMenu)

    let resizeTimer: number | undefined
    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        refitRef.current?.()
      }, TERMINAL_RESIZE_DELAY_MS)
    })
    observer.observe(container)

    return () => {
      disposed = true
      refitRef.current = null
      window.clearTimeout(connectTimer)
      window.clearTimeout(resizeTimer)
      window.clearTimeout(mouseFlushTimer)
      observer.disconnect()
      container.removeEventListener('contextmenu', handleContextMenu)
      dataSub.dispose()
      if (ws !== null && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close()
      }
      if (wsRef.current === ws) wsRef.current = null
      term.dispose()
      if (termRef.current === term) termRef.current = null
    }
  }, [project.id, connectNonce])

  /* — re-read the token theme when the paper swaps; deferred a tick so
       the .dark class toggle (a parent effect) lands first — */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const term = termRef.current
      if (term !== null) term.options.theme = readTerminalTheme()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [theme])

  /* — surface the connection status upward (live marker) — read the
       callback through a ref so a changing prop identity doesn't re-fire,
       and report 'closed' once on unmount — */
  const onStatusChangeRef = useRef(onStatusChange)
  onStatusChangeRef.current = onStatusChange
  useEffect(() => {
    onStatusChangeRef.current?.(status)
  }, [status])
  useEffect(() => {
    return () => {
      onStatusChangeRef.current?.('closed')
    }
  }, [])

  /* keep the right-click menu fully on screen (clamp into the viewport once it
     has measured), and close it on an outside click or Escape */
  useLayoutEffect(() => {
    const el = ctxMenuRef.current
    if (ctxMenu === null || el === null) return
    const rect = el.getBoundingClientRect()
    const pad = 8
    const x = Math.max(pad, Math.min(ctxMenu.x, window.innerWidth - rect.width - pad))
    const y = Math.max(pad, Math.min(ctxMenu.y, window.innerHeight - rect.height - pad))
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }, [ctxMenu])
  useEffect(() => {
    if (ctxMenu === null) return
    const onDown = (e: MouseEvent) => {
      if (ctxMenuRef.current !== null && !ctxMenuRef.current.contains(e.target as Node)) {
        setCtxMenu(null)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu])

  /* — right-click menu actions — */
  const handleCopy = () => {
    const term = termRef.current
    if (term !== null && term.hasSelection()) {
      const selection = term.getSelection()
      if (selection !== '') void navigator.clipboard?.writeText(selection).catch(() => {})
      term.clearSelection()
    }
    setCtxMenu(null)
  }
  const handleCut = () => {
    /* a terminal's scrollback is read-only output — there is nothing to remove,
       so Cut copies the selection and clears the highlight (same result as Copy).
       It is offered for muscle-memory; the meaningful half — the clipboard — works. */
    handleCopy()
  }
  const handlePaste = () => {
    void navigator.clipboard
      ?.readText()
      .then((text) => {
        const ws = wsRef.current
        if (text !== '' && ws !== null && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data: text }))
        }
      })
      .catch(() => {})
    setCtxMenu(null)
  }

  const shortSession = boundSessionId !== null ? boundSessionId.slice(0, 8) : 'NEW'
  const showReconnect = status === 'exited' || status === 'closed'

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* — instrument strip (suppressed when the pane shows a merged header) — */}
      {!hideHeader && (
        <div className="flex items-center justify-between gap-4 border-b border-hairline bg-midnight-2 px-6 py-3">
          <div className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.22em] text-sand">
            <span className="text-brass" aria-hidden="true">
              ✦
            </span>{' '}
            Instrument · {project.name} · Session {shortSession}
          </div>
          <div className="flex shrink-0 items-center gap-3 font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim">
            {status === 'connecting' && <span>Lighting…</span>}
            {status === 'connected' && <span className="text-brass">Live</span>}
            {status === 'exited' && (
              <span>Exited{exitCode !== null ? ` · code ${exitCode}` : ''}</span>
            )}
            {status === 'closed' && <span>Link dropped</span>}
            {showReconnect && (
              <button
                type="button"
                onClick={() => setConnectNonce((n) => n + 1)}
                aria-label="Reconnect terminal"
                className="mo-ticks flex h-8 cursor-pointer items-center gap-2 border border-hairline px-3 font-mono text-[9px] uppercase tracking-[0.2em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                Reconnect
              </button>
            )}
          </div>
        </div>
      )}

      {/* — the console — */}
      <div className="relative min-h-0 flex-1 bg-midnight">
        <div ref={containerRef} className="absolute inset-0 px-3 py-2" />
      </div>

      {/* — right-click Copy / Cut / Paste menu — */}
      {ctxMenu !== null && (
        <div
          ref={ctxMenuRef}
          role="menu"
          className="fixed z-50 min-w-[10rem] border border-hairline bg-surface py-1 shadow-lg shadow-black/40"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            disabled={!ctxMenu.hasSelection}
            onClick={handleCopy}
            className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass disabled:cursor-not-allowed disabled:text-sand-dim disabled:hover:bg-transparent disabled:hover:text-sand-dim"
          >
            <Copy className="h-3 w-3" aria-hidden="true" />
            Copy
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!ctxMenu.hasSelection}
            onClick={handleCut}
            className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass disabled:cursor-not-allowed disabled:text-sand-dim disabled:hover:bg-transparent disabled:hover:text-sand-dim"
          >
            <Scissors className="h-3 w-3" aria-hidden="true" />
            Cut
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handlePaste}
            className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
          >
            <ClipboardPaste className="h-3 w-3" aria-hidden="true" />
            Paste
          </button>
        </div>
      )}
    </div>
  )
}

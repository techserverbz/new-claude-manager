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
 * Output is written near-verbatim — the only transform is stripping claude's
 * mouse-tracking modes so a plain drag forms a text selection for right-click
 * Copy (otherwise xterm hands the drag to claude). A NARROW carry holds back
 * only a partial private-mode set across WS frames; it never touches cursor-
 * positioning CSI. On xterm 5.5 this is the misalignment fix: the old code used
 * a BROAD CSI carry that split claude's constant positioning mid-sequence and
 * sheared the grid, and xterm 6's cell measurement compounded it.
 *
 * The session binding is captured ONCE per connection: a sessionId
 * prop change must not tear down a live pty mid-use. Reconnect picks up
 * the latest id.
 */

/* how long the connect (and first fit) is deferred after mount — long enough for
   xterm's renderer to initialize (so the first fit doesn't throw) and past
   StrictMode's synchronous probe mount. */
const TERMINAL_INIT_DELAY_MS = 60

/* Drop ONLY the mouse-tracking modes (1000-1003/1005/1006/1015) from claude's
   output: that keeps xterm out of mouse mode, so a plain left-drag forms a TEXT
   selection for the right-click Copy instead of being handed to claude. claude
   keeps its native alt-screen (clean full-screen rendering — stripping it gains
   nothing here since this claude redraws in place rather than scrolling). Cursor
   visibility (?25), bracketed paste (?2004), focus reporting (?1004), alt-screen
   (?1049) etc. all pass through untouched. */
const STRIP_MODES = new Set([1000, 1001, 1002, 1003, 1005, 1006, 1015])
/* any private-mode set: ESC [ ? <params> (h|l) — params may batch several modes */
const PRIVATE_MODE_SET_RE = /\x1b\[\?([\d;]+)([hl])/g
/* a trailing INCOMPLETE private-mode set (ESC, ESC[, ESC[?, ESC[?<params>) — held
   back across WS frames so a mode sequence ConPTY split mid-CSI isn't missed. It
   matches ONLY the ?-prefixed form, so plain cursor-positioning CSI (ESC[r;cH) is
   NEVER carried/split — the corruption a broad CSI carry caused. */
const PARTIAL_PRIVATE_RE = /\x1b(?:\[(?:\?[\d;]*)?)?$/

/** Drop alt-screen + mouse modes from a chunk, preserving any other private mode
    batched into the same sequence. */
function stripModes(s: string): string {
  return s.replace(PRIVATE_MODE_SET_RE, (_full, params: string, hl: string) => {
    const kept = params.split(';').filter((p) => p !== '' && !STRIP_MODES.has(Number(p)))
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
  /* set by the lifecycle effect — refit the grid to the container (xterm's
     onResize then tells the pty). Called by the ResizeObserver AND an external
     resizeSignal bump (the latter for layout changes the observer can miss). */
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
     can settle inside its debounce — so refit explicitly once it's settled. A
     refit only re-fits the grid (xterm's onResize tells the pty); NO `active`
     gate — every mounted panel resized when the layout did. */
  const lastResizeRef = useRef(resizeSignal)
  useEffect(() => {
    if (resizeSignal === lastResizeRef.current) return
    lastResizeRef.current = resizeSignal
    const t = window.setTimeout(() => refitRef.current?.(), 100)
    return () => window.clearTimeout(t)
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
      scrollback: 10000,
      /* NO convertEol (would add \r before every \n → column resets in claude's
         TUI) and NO tabStopWidth override (claude assumes the standard 8) — both
         desync claude's cursor math from xterm's grid. Manager 26's config. */
      theme: readTerminalTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    /* xterm initializes its renderer asynchronously after open(); fitting before
       it is ready throws inside xterm's syncScrollArea (it reads renderer
       dimensions). So gate EVERY fit behind `ready`, flipped on by the first fit
       in the deferred connect below — by which point the renderer is ready, and
       term.cols/rows are accurate to seed the connect query. */
    let ready = false

    const sendResize = () => {
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }
    /* re-fit the grid to the container. xterm's onResize (below) is what tells
       the pty, so a fit that changes the size sends exactly one resize. */
    refitRef.current = () => {
      if (disposed || !ready) return
      try {
        fit.fit()
      } catch {
        /* container may be mid-layout */
      }
    }
    /* whenever the grid dimensions actually change, tell the pty — claude gets a
       SIGWINCH and repaints at the new width. (No proposeDimensions/blank/pty-
       first dance: in the normal buffer the reflow is xterm-native and clean.) */
    const resizeSub = term.onResize(() => sendResize())

    /* Mouse-wheel pages claude's history: send PageUp/PageDown to the pty instead
       of xterm's default alt-screen wheel→arrow-keys. Throttled so a trackpad
       flick doesn't fly through pages. Always returns false → xterm never sends
       its own arrows. */
    let lastWheelAt = 0
    term.attachCustomWheelEventHandler((e) => {
      if (ws === null || ws.readyState !== WebSocket.OPEN) return false
      const now = e.timeStamp
      if (now - lastWheelAt < 100) return false
      lastWheelAt = now
      const key = e.deltaY < 0 ? '\x1b[5~' : '\x1b[6~' // PageUp : PageDown
      ws.send(JSON.stringify({ type: 'input', data: key }))
      return false
    })

    /* Strip claude's mouse modes (so a drag selects text for Copy), holding back
       only a partial PRIVATE-mode set across WS frames (50ms flush). Cursor
       positioning and all other output are written as-is — the narrow carry
       never splits it (the broad carry that did was the misalignment cause). */
    let modeCarry = ''
    let modeFlushTimer: number | undefined
    const writeOutput = (data: string) => {
      window.clearTimeout(modeFlushTimer)
      let text = stripModes(modeCarry + data)
      modeCarry = ''
      const partial = text.match(PARTIAL_PRIVATE_RE)
      if (partial !== null) {
        modeCarry = partial[0]
        text = text.slice(0, text.length - partial[0].length)
        modeFlushTimer = window.setTimeout(() => {
          if (modeCarry !== '') {
            term.write(modeCarry)
            modeCarry = ''
          }
        }, 50)
      }
      if (text !== '') term.write(text)
    }

    /* the connect is deferred so (a) StrictMode's probe mount never opens a socket
       (which would spawn-and-kill a stray server pty, minting a junk session JSONL
       when sessionId=new), and (b) xterm's renderer is initialized — so the first
       fit here is safe (no syncScrollArea throw) and term.cols/rows are accurate
       to seed the connect query. */
    const connectTimer = window.setTimeout(() => {
      if (disposed) return
      try {
        fit.fit()
      } catch {
        /* container may be mid-layout */
      }
      ready = true
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
      )}&cols=${term.cols}&rows=${term.rows}${force ? '&forceRestart=1' : ''}`
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws/terminal?${query}`)
      ws = socket
      wsRef.current = socket

      socket.onopen = () => {
        if (disposed) return
        setStatus('connected')
        /* the connect query already sized the pty; one settled fit + resize here
           guarantees the grid and the pty agree before the first output wraps. */
        try {
          fit.fit()
        } catch {
          /* container may be mid-layout */
        }
        sendResize()
        term.focus()
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
          writeOutput(parsed.data)
        } else if (parsed.type === 'exit') {
          setStatus('exited')
          setExitCode(typeof parsed.code === 'number' ? parsed.code : null)
        }
      }

      socket.onclose = () => {
        if (disposed) return
        setStatus((s) => (s === 'exited' ? s : 'closed'))
      }
    }, TERMINAL_INIT_DELAY_MS)

    const dataSub = term.onData((data) => {
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })

    /* right-click menu — suppress the browser's native menu (its Copy can't see
       xterm's own selection model) and open our Copy/Cut/Paste menu instead. In
       the normal buffer a plain drag forms a text selection, so getSelection()
       has something to copy. The actions run from render scope (handleCopy etc). */
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      setCtxMenu({ x: e.clientX, y: e.clientY, hasSelection: term.hasSelection() })
    }
    container.addEventListener('contextmenu', handleContextMenu)

    /* re-fit on a real container size change. A 5px threshold ignores sub-cell
       jitter, and a 100ms debounce coalesces a drag's many frames into one fit
       at rest (Manager 26) — no mid-drag garble, no proposeDimensions machinery. */
    let lastW = container.clientWidth
    let lastH = container.clientHeight
    let resizeTimer: number | undefined
    const observer = new ResizeObserver(() => {
      const w = container.clientWidth
      const h = container.clientHeight
      if (Math.abs(w - lastW) < 5 && Math.abs(h - lastH) < 5) return
      lastW = w
      lastH = h
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => refitRef.current?.(), 100)
    })
    observer.observe(container)

    return () => {
      disposed = true
      refitRef.current = null
      window.clearTimeout(connectTimer)
      window.clearTimeout(resizeTimer)
      window.clearTimeout(modeFlushTimer)
      observer.disconnect()
      container.removeEventListener('contextmenu', handleContextMenu)
      resizeSub.dispose()
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

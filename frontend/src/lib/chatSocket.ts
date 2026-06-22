/**
 * chatSocket — singleton manager for the /ws chat channel.
 * Connects lazily on first subscribe, auto-reconnects with capped
 * exponential backoff, queues sends briefly while the socket is down,
 * and fans server events out to every subscriber. The connection lives
 * at module scope so streams survive component unmounts (e.g. the
 * chat panel hopping to the shell tab mid-turn).
 *
 * On a connection drop a synthesized `error` event is fanned out so a
 * panel that is mid-stream can clear its streaming state (the server
 * kills the claude child when the socket dies — the final `done` frame
 * is lost, so without this the UI would stay locked forever).
 */

/** raw claude stream-json object forwarded verbatim by the server */
export interface RawStreamEvent {
  type?: string
  subtype?: string
  session_id?: string
  message?: {
    content?: unknown
    [key: string]: unknown
  }
  event?: {
    type?: string
    delta?: { type?: string; text?: string; [key: string]: unknown }
    [key: string]: unknown
  }
  result?: string
  [key: string]: unknown
}

export type ChatServerEvent =
  | { type: 'session-created'; sessionId: string }
  | { type: 'stream'; event: RawStreamEvent }
  /* sessionId is null when a brand-new turn dies before the CLI's
     system/init event was parsed (abort or clean exit pre-handshake) */
  | { type: 'done'; sessionId: string | null }
  | { type: 'error'; error: string }
  | { type: 'sessions-updated'; projectId: string }

export type ChatSocketListener = (event: ChatServerEvent) => void

const BACKOFF_INITIAL_MS = 500
const BACKOFF_MAX_MS = 8_000
/* only trust a connection (and reset backoff) after it stays open this long —
   prevents an accept-then-drop server from producing a steady 500ms loop */
const BACKOFF_RESET_GRACE_MS = 5_000
/* queued sends older than this are dropped on reconnect — a minutes-old
   'chat' must not kick off a model run the user has moved on from */
const SEND_QUEUE_TTL_MS = 5_000

class ChatSocketManager {
  private ws: WebSocket | null = null
  private listeners = new Set<ChatSocketListener>()
  private pending: { raw: string; queuedAt: number }[] = []
  private backoffMs = BACKOFF_INITIAL_MS
  private reconnectTimer: number | null = null
  private stableTimer: number | null = null

  /** subscribe to server events; returns an unsubscribe function */
  subscribe(listener: ChatSocketListener): () => void {
    this.listeners.add(listener)
    this.ensureConnected()
    return () => {
      this.listeners.delete(listener)
    }
  }

  sendChat(projectId: string, sessionId: string | null, message: string): void {
    this.send({ type: 'chat', projectId, sessionId, message })
  }

  sendAbort(): void {
    this.send({ type: 'abort' })
  }

  /** Force an immediate reconnect: drop the current socket and reopen now,
   *  resetting the backoff. Used by the global "refresh chats" control so a
   *  suspended/half-dead link (e.g. after the browser throttled a backgrounded
   *  tab) recovers at once instead of waiting out the backoff. The old socket's
   *  own onclose still fans out the drop `error` (unsticking any mid-stream
   *  panel) and schedules a reconnect that harmlessly no-ops once it finds the
   *  fresh socket already open. */
  reconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    /* drop the old socket's grace timer too — it lives on a shared field the new
       socket's onopen would otherwise inherit/clobber */
    if (this.stableTimer !== null) {
      window.clearTimeout(this.stableTimer)
      this.stableTimer = null
    }
    this.backoffMs = BACKOFF_INITIAL_MS
    const old = this.ws
    this.ws = null
    if (old !== null) {
      try {
        old.close()
      } catch {
        /* already closing */
      }
    }
    this.ensureConnected()
  }

  private send(payload: unknown): void {
    const raw = JSON.stringify(payload)
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(raw)
    } else {
      this.pending.push({ raw, queuedAt: Date.now() })
      this.ensureConnected()
    }
  }

  private fanOut(event: ChatServerEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private ensureConnected(): void {
    if (
      this.ws !== null &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return
    }
    if (this.reconnectTimer !== null) return

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`)
    this.ws = ws

    ws.onopen = () => {
      /* reset backoff only once the link has proven stable */
      if (this.stableTimer !== null) window.clearTimeout(this.stableTimer)
      this.stableTimer = window.setTimeout(() => {
        this.backoffMs = BACKOFF_INITIAL_MS
        this.stableTimer = null
      }, BACKOFF_RESET_GRACE_MS)

      const now = Date.now()
      const queued = this.pending
      this.pending = []
      for (const item of queued) {
        if (now - item.queuedAt <= SEND_QUEUE_TTL_MS) ws.send(item.raw)
      }
    }

    ws.onmessage = (e: MessageEvent) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(e.data))
      } catch {
        return
      }
      if (parsed === null || typeof parsed !== 'object') return
      const event = parsed as ChatServerEvent
      if (typeof event.type !== 'string') return
      this.fanOut(event)
    }

    ws.onerror = () => {
      ws.close()
    }

    ws.onclose = () => {
      /* the server aborts the active turn when its socket dies — tell the panels
         so a mid-stream UI can unstick (idle listeners ignore this). Fanned out
         even for a SUPERSEDED socket (one replaced by reconnect()), whose dropped
         turn still needs unsticking. */
      this.fanOut({
        type: 'error',
        error: 'Connection to the observatory dropped — the transmission was interrupted.',
      })
      /* only the CURRENT socket owns reconnection + the shared stable timer — a
         superseded socket must not clobber the new socket's timer or schedule a
         redundant reconnect (which would suppress the new socket's own). */
      if (this.ws !== ws) return
      if (this.stableTimer !== null) {
        window.clearTimeout(this.stableTimer)
        this.stableTimer = null
      }
      this.ws = null
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return
    if (this.listeners.size === 0 && this.pending.length === 0) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.ensureConnected()
    }, delay)
  }
}

export const chatSocket = new ChatSocketManager()

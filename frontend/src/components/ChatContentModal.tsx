import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, ChevronUp, Search, Wrench, X } from 'lucide-react'
import { api, relativeTime } from '../lib/api'
import type { ChatMessage } from '../lib/api'

/** a short, readable one-liner describing a tool call's input */
function toolSummary(input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const pick = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '')
  let s =
    pick('command') ||
    pick('file_path') ||
    pick('path') ||
    pick('pattern') ||
    pick('url') ||
    pick('query') ||
    pick('prompt') ||
    pick('description')
  if (s === '') {
    try {
      s = JSON.stringify(o)
    } catch {
      s = ''
    }
  }
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > 160 ? s.slice(0, 160) + '…' : s
}

/**
 * ChatContentModal — a read-only quick-look at a chat's transcript, opened from
 * the sidebar right-click "View". Fetches the messages by cwd + sessionId (no
 * pane / project needed) and renders them plainly, with an in-transcript search
 * that highlights matches and steps through them (prev / next). Opens at the
 * foot (latest messages).
 */

export function ChatContentModal({
  target,
  onClose,
}: {
  /** null = closed; otherwise the chat to preview */
  target: { sessionId: string; cwd: string; title: string } | null
  onClose: () => void
}) {
  const open = target !== null
  const [messages, setMessages] = useState<ChatMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (target === null) return
    setMessages(null)
    setError(null)
    setQuery('')
    let cancelled = false
    api
      .getMessagesByCwd(target.cwd, target.sessionId)
      .then((m) => {
        if (!cancelled) setMessages(m)
      })
      .catch(() => {
        if (!cancelled) setError('Could not read this chat’s transcript.')
      })
    return () => {
      cancelled = true
    }
  }, [target])

  /* on load with no active search, open at the foot (latest messages) */
  useEffect(() => {
    if (messages === null || query.trim() !== '') return
    const el = bodyRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [messages, query])

  /* reset to the first match whenever the query changes */
  useEffect(() => {
    setActiveMatch(0)
  }, [query])

  useEffect(() => {
    if (!open) return
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const timer = window.setTimeout(() => dialogRef.current?.focus(), 0)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
      restoreFocusRef.current?.focus()
      restoreFocusRef.current = null
    }
  }, [open, onClose])

  const copy = (text: string) => void navigator.clipboard?.writeText(text)

  /* — build the message list, wrapping query matches in <mark> and assigning each
       a global index so prev/next can scroll to it — */
  const ql = query.trim().toLowerCase()
  const counter = { n: 0 }
  const renderContent = (text: string): ReactNode => {
    if (ql === '') return text
    const lower = text.toLowerCase()
    const out: ReactNode[] = []
    let i = 0
    for (;;) {
      const idx = lower.indexOf(ql, i)
      if (idx === -1) {
        out.push(text.slice(i))
        break
      }
      if (idx > i) out.push(text.slice(i, idx))
      const gi = counter.n++
      out.push(
        <mark
          key={`mk-${gi}`}
          id={`cm-match-${gi}`}
          className={
            gi === activeMatch
              ? 'rounded-sm bg-brass px-0.5 text-midnight'
              : 'rounded-sm bg-brass/30 px-0.5 text-parchment'
          }
        >
          {text.slice(idx, idx + ql.length)}
        </mark>,
      )
      i = idx + ql.length
    }
    return out
  }

  const renderedMessages =
    messages === null
      ? []
      : messages.map((m) => {
          const isUser = m.role === 'user'
          return (
            <li key={m.id}>
              <div className="flex items-baseline gap-2">
                <span
                  className={`font-mono text-[10px] uppercase tracking-[0.2em] ${
                    isUser ? 'text-brass' : 'text-sand'
                  }`}
                >
                  {isUser ? 'You' : 'Claude'}
                </span>
                <span className="font-mono text-[9px] tracking-[0.04em] text-sand-dim">
                  {relativeTime(m.timestamp)}
                </span>
              </div>
              {m.content.trim() !== '' && (
                <p className="mt-1.5 whitespace-pre-wrap break-words font-display text-[14px] leading-relaxed text-parchment">
                  {renderContent(m.content)}
                </p>
              )}
              {m.toolUse && m.toolUse.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {m.toolUse.map((t, i) => {
                    const s = toolSummary(t.input)
                    return (
                      <div
                        key={i}
                        className="border-l-2 border-brass/50 bg-surface-2/30 px-2.5 py-1.5"
                      >
                        <div className="flex items-center gap-1.5">
                          <Wrench className="h-3 w-3 shrink-0 text-brass" aria-hidden="true" />
                          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-brass">
                            {t.name}
                          </span>
                        </div>
                        {s !== '' && (
                          <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-sand-dim">
                            {s}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </li>
          )
        })
  const matchCount = counter.n

  /* scroll the active match into view as it changes */
  useEffect(() => {
    if (ql === '' || matchCount === 0) return
    const el = document.getElementById(`cm-match-${activeMatch}`)
    el?.scrollIntoView({ block: 'center' })
  }, [activeMatch, ql, matchCount, messages])

  const go = (delta: number) => {
    if (matchCount === 0) return
    setActiveMatch((cur) => (cur + delta + matchCount) % matchCount)
  }

  return (
    <AnimatePresence>
      {open && target !== null && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.25, ease: 'easeOut' } }}
          exit={{ opacity: 0, transition: { duration: 0.18, ease: 'easeIn' } }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-midnight/70 px-6"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.2, 0.6, 0.2, 1] } }}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.18, ease: 'easeIn' } }}
            ref={dialogRef}
            tabIndex={-1}
            style={{ background: 'var(--color-surface)' }}
            className="mo-card flex h-[80vh] w-full max-w-3xl flex-col shadow-2xl shadow-black/50"
            role="dialog"
            aria-modal="true"
            aria-label={`Chat content — ${target.title}`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* — header — */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
                  <span className="text-brass" aria-hidden="true">
                    ✦
                  </span>{' '}
                  Chat Content
                </div>
                <h2 className="mt-2 truncate font-display text-[24px] font-medium leading-tight text-parchment">
                  {target.title}
                </h2>
                <p className="mt-1 truncate font-mono text-[9px] tracking-[0.04em] text-sand-dim">
                  {target.cwd} · {target.sessionId.slice(0, 8)}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="mo-ticks flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center border border-transparent text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {/* — search this transcript — */}
            <div className="mt-4 flex items-center gap-2 border border-hairline px-3 transition-colors duration-200 focus-within:border-brass">
              <Search className="h-3.5 w-3.5 shrink-0 text-sand-dim" aria-hidden="true" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') go(e.shiftKey ? -1 : 1)
                }}
                placeholder="Search this chat…"
                spellCheck={false}
                aria-label="Search this chat"
                className="w-full bg-transparent py-2 font-mono text-[12px] text-parchment placeholder:text-sand-dim outline-none"
              />
              {query.trim() !== '' && (
                <>
                  <span className="shrink-0 font-mono text-[9px] tracking-[0.08em] text-sand-dim">
                    {matchCount === 0 ? '0/0' : `${activeMatch + 1}/${matchCount}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => go(-1)}
                    disabled={matchCount === 0}
                    aria-label="Previous match"
                    title="Previous (Shift+Enter)"
                    className="shrink-0 cursor-pointer text-sand-dim transition-colors duration-150 hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => go(1)}
                    disabled={matchCount === 0}
                    aria-label="Next match"
                    title="Next (Enter)"
                    className="shrink-0 cursor-pointer text-sand-dim transition-colors duration-150 hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    aria-label="Clear search"
                    className="shrink-0 cursor-pointer text-sand-dim transition-colors duration-150 hover:text-brass"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </>
              )}
            </div>

            {/* — body — */}
            <div
              ref={bodyRef}
              className="mt-4 min-h-0 flex-1 overflow-y-auto border-t border-hairline-s pt-4"
            >
              {error !== null ? (
                <p className="px-1 font-display text-[14px] italic text-[#cf6b52]">{error}</p>
              ) : messages === null ? (
                <p className="px-1 font-display text-[14px] italic text-sand">Reading transcript…</p>
              ) : messages.length === 0 ? (
                <p className="px-1 font-display text-[14px] italic text-sand-dim">
                  This chat has no messages yet.
                </p>
              ) : (
                <ul className="space-y-5">{renderedMessages}</ul>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

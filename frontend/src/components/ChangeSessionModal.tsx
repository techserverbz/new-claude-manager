import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'

/**
 * ChangeSessionModal — paste/edit a session id and load it into the focused
 * window (resumes that session). Solid plate over a scrim, matching the
 * project modal; .mo-card is transparent by design so we force an opaque
 * surface inline.
 */

const FIELD_CLASS =
  'w-full border border-hairline bg-transparent px-4 py-3 font-mono text-[13px] ' +
  'tracking-[0.02em] text-parchment placeholder:text-sand-dim transition-colors duration-200 focus:border-brass'

export function ChangeSessionModal({
  open,
  current,
  onClose,
  onSubmit,
}: {
  open: boolean
  /** the session id to prefill (the chat you right-clicked) */
  current: string
  onClose: () => void
  /** load this session id into the focused window */
  onSubmit: (sessionId: string) => void
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setValue(current)
    const t = window.setTimeout(() => inputRef.current?.select(), 0)
    return () => window.clearTimeout(t)
  }, [open, current])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const v = value.trim()
    // empty = a fresh session; otherwise the claude session-id charset
    if (v !== '' && !/^[a-zA-Z0-9-]+$/.test(v)) return
    onSubmit(v)
    onClose()
  }

  return (
    <AnimatePresence>
      {open && (
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
            style={{ background: 'var(--color-surface)' }}
            className="mo-card w-full max-w-md shadow-2xl shadow-black/50"
            role="dialog"
            aria-modal="true"
            aria-label="Change session id"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
                  <span className="text-brass" aria-hidden="true">
                    ✦
                  </span>{' '}
                  Session
                </div>
                <h2 className="mt-2 font-display text-[26px] font-medium leading-tight tracking-[-0.005em] text-parchment">
                  Change <em className="font-normal italic text-brass">session id</em>
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="mo-ticks flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center border border-transparent text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="mt-5 space-y-4">
              <div>
                <label htmlFor="cs-id" className="block font-mono text-[10px] uppercase tracking-[0.22em] text-sand">
                  Session id
                </label>
                <input
                  id="cs-id"
                  ref={inputRef}
                  type="text"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="paste a session id (blank = new session)"
                  spellCheck={false}
                  className={`mt-2 ${FIELD_CLASS}`}
                />
                <p className="mt-2 font-display text-[13px] italic leading-relaxed text-sand">
                  Loads this session into the focused window (resumes it). Leave blank to start a
                  fresh session.
                </p>
              </div>
              <div className="flex justify-end gap-3 border-t border-hairline-s pt-4">
                <button
                  type="button"
                  onClick={onClose}
                  className="mo-ticks cursor-pointer border border-hairline px-4 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
                >
                  Cancel
                </button>
                <button type="submit" className="mo-button">
                  Load session
                </button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

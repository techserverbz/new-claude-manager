import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUp, Folder, HardDrive, X } from 'lucide-react'
import { api } from '../lib/api'

/**
 * FolderPicker — an in-app directory browser styled to match the app. Navigate
 * into folders, jump up, type a path, then "Use this folder". Replaces the dated
 * native Windows folder dialog. Sits above other modals (z-[60]).
 */

interface Entry {
  name: string
  path: string
}

export function FolderPicker({
  open,
  initialPath,
  onPick,
  onClose,
}: {
  open: boolean
  initialPath?: string
  onPick: (path: string) => void
  onClose: () => void
}) {
  const [current, setCurrent] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [parent, setParent] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  /* seed the starting location each time it opens */
  useEffect(() => {
    if (!open) return
    setCurrent(initialPath?.trim() || '')
  }, [open, initialPath])

  /* load the current location's sub-folders */
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .listDir(current)
      .then((res) => {
        if (cancelled) return
        setEntries(res.entries)
        setParent(res.parent)
        setCurrent(res.path)
        setDraft(res.path)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not read that folder.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, current])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const t = window.setTimeout(() => dialogRef.current?.focus(), 0)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.clearTimeout(t)
    }
  }, [open, onClose])

  const atDrives = current === ''

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.2, ease: 'easeOut' } }}
          exit={{ opacity: 0, transition: { duration: 0.15, ease: 'easeIn' } }}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-midnight/80 px-6"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.2, 0.6, 0.2, 1] } }}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.15, ease: 'easeIn' } }}
            ref={dialogRef}
            tabIndex={-1}
            style={{ background: 'var(--color-surface)' }}
            className="mo-card flex h-[70vh] w-full max-w-xl flex-col shadow-2xl shadow-black/50"
            role="dialog"
            aria-modal="true"
            aria-label="Choose a folder"
            onClick={(e) => e.stopPropagation()}
          >
            {/* — header — */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
                  <span className="text-brass" aria-hidden="true">
                    ✦
                  </span>{' '}
                  Choose a folder
                </div>
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

            {/* — path bar — */}
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCurrent(parent ?? '')}
                disabled={parent === null}
                title="Up one level"
                aria-label="Up one level"
                className="mo-ticks flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand transition-colors duration-150 hover:border-brass hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setCurrent(draft.trim())
                }}
                placeholder="This PC (pick a drive below)"
                spellCheck={false}
                className="min-w-0 flex-1 border border-hairline bg-transparent px-3 py-2 font-mono text-[12px] text-parchment placeholder:text-sand-dim outline-none transition-colors duration-200 focus:border-brass"
              />
            </div>

            {/* — folder list — */}
            <div className="mt-3 min-h-0 flex-1 overflow-y-auto border border-hairline-s">
              {loading ? (
                <p className="px-3 py-3 font-display text-[13px] italic text-sand">Loading…</p>
              ) : error !== null ? (
                <p className="px-3 py-3 font-display text-[13px] italic text-[#cf6b52]">{error}</p>
              ) : entries.length === 0 ? (
                <p className="px-3 py-3 font-display text-[13px] italic text-sand-dim">
                  No sub-folders here.
                </p>
              ) : (
                entries.map((e) => (
                  <button
                    key={e.path}
                    type="button"
                    onClick={() => setCurrent(e.path)}
                    className="group flex w-full cursor-pointer items-center gap-2.5 border-b border-hairline-s px-3 py-2 text-left transition-colors duration-150 last:border-b-0 hover:bg-surface-2/50"
                  >
                    {atDrives ? (
                      <HardDrive
                        className="h-3.5 w-3.5 shrink-0 text-sand-dim transition-colors duration-150 group-hover:text-brass"
                        aria-hidden="true"
                      />
                    ) : (
                      <Folder
                        className="h-3.5 w-3.5 shrink-0 text-sand-dim transition-colors duration-150 group-hover:text-brass"
                        aria-hidden="true"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-parchment">
                      {e.name}
                    </span>
                  </button>
                ))
              )}
            </div>

            {/* — footer — */}
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-hairline-s pt-4">
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-sand-dim">
                {atDrives ? 'Select a drive to begin' : current}
              </span>
              <button
                type="button"
                onClick={onClose}
                className="mo-ticks cursor-pointer border border-hairline px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => onPick(current)}
                disabled={atDrives}
                className="mo-button disabled:cursor-not-allowed disabled:opacity-50"
              >
                Use this folder
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

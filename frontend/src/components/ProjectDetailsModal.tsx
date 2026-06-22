import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Copy, FolderOpen, Pencil, Play, Terminal, X } from 'lucide-react'
import { api } from '../lib/api'
import type { ChatGroup } from '../lib/api'

/**
 * ProjectDetailsModal — read-only "show project" view of a chat-group Project:
 * its color, name, reference directory (with an Open-folder action), description,
 * created date, and every chat (session id + the Claude directory it runs in).
 * An "Edit project" action hands off to the EditProjectModal.
 */

const LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.22em] text-sand-dim'

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso || '—'
  return d.toLocaleString()
}

export function ProjectDetailsModal({
  group,
  onClose,
  onEdit,
}: {
  /** null = closed; otherwise the project to show */
  group: ChatGroup | null
  onClose: () => void
  onEdit: () => void
}) {
  const open = group !== null
  const [revealError, setRevealError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (group !== null) setRevealError(null)
  }, [group])

  useEffect(() => {
    if (!open) return
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const timer = window.setTimeout(() => dialogRef.current?.focus(), 0)
    return () => {
      window.clearTimeout(timer)
      restoreFocusRef.current?.focus()
      restoreFocusRef.current = null
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const copy = (text: string) => void navigator.clipboard?.writeText(text)

  const openFolder = async (path: string) => {
    if (path.trim() === '') return
    setRevealError(null)
    try {
      await api.revealPath(path)
    } catch (err) {
      setRevealError(err instanceof Error ? err.message : 'Could not open the folder.')
    }
  }

  const runCommand = async (dir: string, command: string) => {
    if (command.trim() === '') return
    setRevealError(null)
    try {
      await api.runCommand(dir, command)
    } catch (err) {
      setRevealError(err instanceof Error ? err.message : 'Could not run the command.')
    }
  }

  return (
    <AnimatePresence>
      {open && group !== null && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.3, ease: 'easeOut' } }}
          exit={{ opacity: 0, transition: { duration: 0.22, ease: 'easeIn' } }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-midnight/70 px-6"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.2, 0.6, 0.2, 1] } }}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.22, ease: 'easeIn' } }}
            ref={dialogRef}
            tabIndex={-1}
            style={{ background: 'var(--color-surface)' }}
            className="mo-card flex max-h-[90vh] w-full max-w-4xl flex-col shadow-2xl shadow-black/50"
            role="dialog"
            aria-modal="true"
            aria-label={`Project details — ${group.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* — header — */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
                  <span className="text-brass" aria-hidden="true">
                    ✦
                  </span>{' '}
                  Project Details
                </div>
                <h2 className="mt-2 flex items-center gap-2.5 font-display text-[28px] font-medium leading-tight tracking-[-0.005em] text-parchment">
                  {group.color !== '' && (
                    <span
                      aria-hidden="true"
                      style={{ background: group.color }}
                      className="inline-block h-3.5 w-3.5 shrink-0 rounded-full"
                    />
                  )}
                  <span className="truncate">{group.name}</span>
                </h2>
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

            <div className="mt-6 min-h-0 flex-1 space-y-5 overflow-y-auto">
              {/* — directories — */}
              <div>
                <span className={LABEL_CLASS}>Project Directories (reference)</span>
                {group.directories.length === 0 ? (
                  <p className="mt-1.5 font-display text-[14px] italic text-sand-dim">
                    No directories set.
                  </p>
                ) : (
                  <ul className="mt-1.5 space-y-2">
                    {group.directories.map((d, i) => (
                      <li key={i} className="border border-hairline-s px-2.5 py-2">
                        <div className="flex items-center gap-2">
                          <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-parchment">
                            {d.path}
                          </code>
                          <button
                            type="button"
                            onClick={() => openFolder(d.path)}
                            title="Open folder"
                            aria-label="Open folder"
                            className="mo-ticks flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand transition-colors duration-150 hover:border-brass hover:text-brass"
                          >
                            <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => copy(d.path)}
                            title="Copy path"
                            aria-label="Copy path"
                            className="mo-ticks flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand transition-colors duration-150 hover:border-brass hover:text-brass"
                          >
                            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </div>
                        {d.commands.length > 0 && (
                          <div className="mt-2 space-y-1.5">
                            {d.commands.map((cmd, ci) => (
                              <div key={ci} className="flex items-center gap-2">
                                <Terminal
                                  className="h-3.5 w-3.5 shrink-0 text-sand-dim"
                                  aria-hidden="true"
                                />
                                <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-sand">
                                  {cmd}
                                </code>
                                <button
                                  type="button"
                                  onClick={() => copy(cmd)}
                                  title="Copy command"
                                  aria-label="Copy command"
                                  className="mo-ticks flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand transition-colors duration-150 hover:border-brass hover:text-brass"
                                >
                                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void runCommand(d.path, cmd)}
                                  title="Run in a new terminal"
                                  aria-label="Run command"
                                  className="mo-ticks flex h-8 shrink-0 cursor-pointer items-center gap-1.5 border border-brass px-2.5 font-mono text-[9px] uppercase tracking-[0.16em] text-brass transition-colors duration-150 hover:bg-brass/10"
                                >
                                  <Play className="h-3 w-3" aria-hidden="true" />
                                  Run
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {revealError !== null && (
                  <p role="alert" className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#cf6b52]">
                    {revealError}
                  </p>
                )}
              </div>

              {/* — description — */}
              <div>
                <span className={LABEL_CLASS}>Description</span>
                {group.description.trim() === '' ? (
                  <p className="mt-1.5 font-display text-[14px] italic text-sand-dim">
                    No description yet.
                  </p>
                ) : (
                  <p className="mt-1.5 whitespace-pre-wrap font-display text-[14px] leading-relaxed text-parchment">
                    {group.description}
                  </p>
                )}
              </div>

              {/* — created — */}
              <div>
                <span className={LABEL_CLASS}>Created</span>
                <p className="mt-1.5 font-mono text-[12px] text-sand">{formatDate(group.createdAt)}</p>
              </div>

              {/* — chats — */}
              <div>
                <span className={LABEL_CLASS}>
                  Chats · {group.chats.length}
                </span>
                {group.chats.length === 0 ? (
                  <p className="mt-1.5 font-display text-[14px] italic text-sand-dim">
                    No chats in this project yet.
                  </p>
                ) : (
                  <ul className="mt-1.5 space-y-2">
                    {group.chats.map((c) => (
                      <li key={c.sessionId} className="border border-hairline-s px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <code className="truncate font-mono text-[11px] text-parchment">
                            {c.sessionId}
                          </code>
                          <button
                            type="button"
                            onClick={() => copy(c.sessionId)}
                            title="Copy session id"
                            aria-label="Copy session id"
                            className="shrink-0 cursor-pointer text-sand-dim transition-colors duration-150 hover:text-brass"
                          >
                            <Copy className="h-3 w-3" aria-hidden="true" />
                          </button>
                        </div>
                        <div className="mt-1 truncate font-mono text-[9px] tracking-[0.04em] text-sand-dim">
                          {c.cwd || '—'}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* — project id — */}
              <div>
                <span className={LABEL_CLASS}>Project ID</span>
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate border border-hairline-s px-3 py-2 font-mono text-[11px] text-sand">
                    {group.id}
                  </code>
                  <button
                    type="button"
                    onClick={() => copy(group.id)}
                    title="Copy id"
                    aria-label="Copy id"
                    className="mo-ticks flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand transition-colors duration-150 hover:border-brass hover:text-brass"
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3 border-t border-hairline-s pt-5">
              <button
                type="button"
                onClick={onClose}
                className="mo-ticks cursor-pointer border border-hairline px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                Close
              </button>
              <button
                type="button"
                onClick={onEdit}
                className="mo-button flex items-center gap-2"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                Edit project
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

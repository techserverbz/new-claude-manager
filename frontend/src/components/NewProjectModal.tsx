import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, FolderGit2, Search, X } from 'lucide-react'
import { api } from '../lib/api'
import type { DiscoveredProject, Project } from '../lib/api'

/**
 * NewProjectModal — "chart a new project" overlay.
 * A midnight-paper .mo-card plate over a soft scrim; mono uppercase
 * labels, hairline inputs warming to brass on focus, inline error
 * from the POST, and the mo-button CTA "Chart this project".
 */

const FIELD_CLASS =
  'w-full border border-hairline bg-transparent px-4 py-3 font-display text-[15px] ' +
  'text-parchment placeholder:text-sand-dim transition-colors duration-200 focus:border-brass'

const LABEL_CLASS = 'block font-mono text-[10px] uppercase tracking-[0.22em] text-sand'

export function NewProjectModal({
  open,
  onClose,
  onCreated,
  editProject = null,
}: {
  open: boolean
  onClose: () => void
  onCreated: (project: Project) => void
  /** when set, the modal EDITS this project instead of creating a new one */
  editProject?: Project | null
}) {
  const isEdit = editProject !== null
  const [name, setName] = useState('')
  const [fileDir, setFileDir] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  /* "pick an existing Claude project" — directories under ~/.claude/projects */
  const [discovered, setDiscovered] = useState<DiscoveredProject[]>([])
  const [pickerQuery, setPickerQuery] = useState('')

  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  /* — focus management: move focus into the dialog on open, restore to
       the invoking control on close (aria-modal alone doesn't trap) — */
  useEffect(() => {
    if (!open) return
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const timer = window.setTimeout(() => {
      const dialog = dialogRef.current
      const firstField = dialog?.querySelector<HTMLElement>('input')
      ;(firstField ?? dialog)?.focus()
    }, 0)
    return () => {
      window.clearTimeout(timer)
      restoreFocusRef.current?.focus()
      restoreFocusRef.current = null
    }
  }, [open])

  /* keep Tab cycling inside the dialog while it is open */
  const handleTrapKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return
    const dialog = dialogRef.current
    if (dialog === null) return
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute('disabled'))
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  /* on open: prefill (edit = the project's values; new = blank). Every project
     uses the global ~/.claude — there is no per-project Claude config. */
  useEffect(() => {
    if (!open) return
    setError(null)
    setSubmitting(false)
    setPickerQuery('')
    if (isEdit && editProject !== null) {
      setName(editProject.name)
      setFileDir(editProject.fileDir)
      return
    }
    setName('')
    setFileDir('')
    // load directories Claude already has sessions for (the picker)
    let cancelled = false
    api
      .discoverProjects()
      .then((list) => {
        if (!cancelled) setDiscovered(list)
      })
      .catch(() => {
        if (!cancelled) setDiscovered([])
      })
    return () => {
      cancelled = true
    }
  }, [open, isEdit, editProject])

  /* escape closes */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      if (isEdit && editProject !== null) {
        // claudeDir:'' resets to the global ~/.claude — repairs any project that
        // previously got a per-project config.
        const project = await api.updateProject(editProject.id, {
          name: name.trim(),
          fileDir: fileDir.trim(),
          claudeDir: '',
        })
        onCreated(project)
      } else {
        // no claudeDir sent => server uses the global ~/.claude
        const project = await api.createProject({ name: name.trim(), fileDir: fileDir.trim() })
        onCreated(project)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save — try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const q = pickerQuery.trim().toLowerCase()
  const filteredDiscovered =
    q === ''
      ? discovered
      : discovered.filter(
          (d) => d.name.toLowerCase().includes(q) || d.fileDir.toLowerCase().includes(q),
        )

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.3, ease: 'easeOut' } }}
          exit={{ opacity: 0, transition: { duration: 0.22, ease: 'easeIn' } }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-midnight/70 px-6"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{
              opacity: 1,
              y: 0,
              transition: { duration: 0.7, ease: [0.2, 0.6, 0.2, 1] },
            }}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.22, ease: 'easeIn' } }}
            ref={dialogRef}
            tabIndex={-1}
            /* solid panel — .mo-card is transparent by design, so force an
               opaque surface here (inline style beats the class) */
            style={{ background: 'var(--color-surface)' }}
            className="mo-card w-full max-w-lg shadow-2xl shadow-black/50"
            role="dialog"
            aria-modal="true"
            aria-label={isEdit ? 'Edit project' : 'Chart a new project'}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleTrapKeyDown}
          >
            {/* — header — */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
                  <span className="text-brass" aria-hidden="true">
                    ✦
                  </span>{' '}
                  {isEdit ? 'Edit Project' : 'New Project'}
                </div>
                <h2 className="mt-2 font-display text-[28px] font-medium leading-tight tracking-[-0.005em] text-parchment">
                  {isEdit ? (
                    <>
                      Edit <em className="font-normal italic text-brass">project</em>
                    </>
                  ) : (
                    <>
                      Chart a <em className="font-normal italic text-brass">project</em>
                    </>
                  )}
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

            <form onSubmit={handleSubmit} className="mt-6 space-y-5">
              <div>
                <label htmlFor="np-name" className={LABEL_CLASS}>
                  Project Name
                </label>
                <input
                  id="np-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="The Northern Survey"
                  className={`mt-2 ${FIELD_CLASS}`}
                />
              </div>

              <div>
                <label htmlFor="np-filedir" className={LABEL_CLASS}>
                  File Directory
                </label>
                <input
                  id="np-filedir"
                  type="text"
                  required
                  value={fileDir}
                  onChange={(e) => setFileDir(e.target.value)}
                  placeholder="C:\Users\you\projects\survey"
                  spellCheck={false}
                  className={`mt-2 ${FIELD_CLASS}`}
                />
              </div>

              {!isEdit && discovered.length > 0 && (
                <div>
                  <span className={LABEL_CLASS}>Or pick an existing Claude project</span>
                  <div className="mt-2 flex items-center gap-2 border border-hairline px-3">
                    <Search className="h-3.5 w-3.5 shrink-0 text-sand-dim" aria-hidden="true" />
                    <input
                      type="text"
                      value={pickerQuery}
                      onChange={(e) => setPickerQuery(e.target.value)}
                      placeholder="Search your projects…"
                      spellCheck={false}
                      className="w-full bg-transparent py-2 font-mono text-[12px] text-parchment placeholder:text-sand-dim outline-none"
                    />
                  </div>
                  <div className="no-scrollbar mt-1 max-h-44 overflow-y-auto border border-hairline-s">
                    {filteredDiscovered.length === 0 ? (
                      <p className="px-3 py-3 font-display text-[13px] italic text-sand-dim">
                        No matches.
                      </p>
                    ) : (
                      filteredDiscovered.map((d) => (
                        <button
                          key={d.fileDir}
                          type="button"
                          disabled={d.registered}
                          onClick={() => {
                            setFileDir(d.fileDir)
                            setName(d.name)
                          }}
                          className="group flex w-full items-center gap-2.5 border-b border-hairline-s px-3 py-2 text-left transition-colors duration-150 last:border-b-0 enabled:cursor-pointer enabled:hover:bg-surface-2/50 disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          <FolderGit2
                            className="h-3.5 w-3.5 shrink-0 text-sand-dim transition-colors duration-150 group-enabled:group-hover:text-brass"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-[11px] uppercase tracking-[0.06em] text-parchment">
                              {d.name}
                            </span>
                            <span className="block truncate font-mono text-[9px] tracking-[0.04em] text-sand-dim">
                              {d.fileDir}
                            </span>
                          </span>
                          <span className="shrink-0 font-mono text-[9px] text-sand-dim">
                            {d.sessionCount}
                          </span>
                          {d.registered && (
                            <span className="flex shrink-0 items-center gap-1 font-mono text-[9px] uppercase tracking-[0.1em] text-brass">
                              <Check className="h-3 w-3" aria-hidden="true" />
                              added
                            </span>
                          )}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}

              <p className="font-display text-[13px] italic leading-relaxed text-sand">
                This is just a folder — its chats live in your global{' '}
                <span className="font-mono not-italic text-sand-dim">.claude</span>, shared with
                every project. No separate Claude setup is created.
              </p>

              {error !== null && (
                <p role="alert" className="border border-brass px-4 py-3 font-mono text-[11px] uppercase tracking-[0.16em] text-brass">
                  {error}
                </p>
              )}

              <div className="flex justify-end border-t border-hairline-s pt-5">
                <button
                  type="submit"
                  disabled={submitting}
                  className="mo-button disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting
                    ? isEdit
                      ? 'Saving…'
                      : 'Charting…'
                    : isEdit
                      ? 'Save changes'
                      : 'Chart this project'}
                </button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { FolderSearch, GripVertical, Plus, Terminal, Trash2, X } from 'lucide-react'
import type { ChatGroup, GroupDirectory } from '../lib/api'
import { FolderPicker } from './FolderPicker'

/**
 * EditProjectModal — edit a Project (chat group): its name, any number of
 * reference working directories (NOT the Claude config dir), a free-text
 * description, and a color label. Mirrors NewProjectModal's plate styling.
 */

const FIELD_CLASS =
  'w-full border border-hairline bg-transparent px-4 py-3 font-display text-[15px] ' +
  'text-parchment placeholder:text-sand-dim transition-colors duration-200 focus:border-brass'
const LABEL_CLASS = 'block font-mono text-[10px] uppercase tracking-[0.22em] text-sand'

/** the project color-label palette (brass-observatory hues) */
export const PROJECT_COLORS = ['#d4a437', '#cf6b52', '#6b9bd1', '#7faa6e', '#b07bc4', '#d99a4e']

export function EditProjectModal({
  group,
  onClose,
  onSave,
}: {
  /** null = closed; otherwise the project being edited */
  group: ChatGroup | null
  onClose: () => void
  onSave: (
    id: string,
    input: { name: string; directories: GroupDirectory[]; description: string; color: string },
  ) => Promise<void> | void
}) {
  const open = group !== null
  const [name, setName] = useState('')
  const [directories, setDirectories] = useState<GroupDirectory[]>([])
  const [description, setDescription] = useState('')
  const [color, setColor] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  /* prefill from the project each time it opens */
  useEffect(() => {
    if (group === null) return
    setName(group.name)
    setDirectories(group.directories.map((d) => ({ path: d.path, commands: [...(d.commands ?? [])] })))
    setDescription(group.description ?? '')
    setColor(group.color ?? '')
    setError(null)
    setSubmitting(false)
  }, [group])

  const [pickerRow, setPickerRow] = useState<number | null>(null)
  const setDirPath = (i: number, path: string) =>
    setDirectories((prev) => prev.map((d, idx) => (idx === i ? { ...d, path } : d)))
  const addDir = () => setDirectories((prev) => [...prev, { path: '', commands: [] }])
  const removeDir = (i: number) => setDirectories((prev) => prev.filter((_, idx) => idx !== i))
  /* per-directory terminal commands — a directory can carry several quick-launches */
  const setDirCommand = (i: number, ci: number, command: string) =>
    setDirectories((prev) =>
      prev.map((d, idx) =>
        idx === i ? { ...d, commands: d.commands.map((c, cIdx) => (cIdx === ci ? command : c)) } : d,
      ),
    )
  const addCommand = (i: number) =>
    setDirectories((prev) =>
      prev.map((d, idx) => (idx === i ? { ...d, commands: [...d.commands, ''] } : d)),
    )
  const removeCommand = (i: number, ci: number) =>
    setDirectories((prev) =>
      prev.map((d, idx) =>
        idx === i ? { ...d, commands: d.commands.filter((_, cIdx) => cIdx !== ci) } : d,
      ),
    )
  /* drag-to-reorder the directory rows (the order persists on save) */
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const reorderDir = (from: number, to: number) =>
    setDirectories((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })

  /* focus management — move focus in on open, restore on close */
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

  /* escape closes */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /* keep Tab cycling inside the dialog */
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

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (submitting || group === null) return
    if (name.trim() === '') {
      setError('A project name is required.')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      await onSave(group.id, {
        name: name.trim(),
        directories: directories
          .map((d) => ({
            path: d.path.trim(),
            commands: d.commands.filter((c) => c.trim() !== ''),
          }))
          .filter((d) => d.path !== ''),
        description,
        color,
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save — try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
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
            animate={{ opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.2, 0.6, 0.2, 1] } }}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.22, ease: 'easeIn' } }}
            ref={dialogRef}
            tabIndex={-1}
            style={{ background: 'var(--color-surface)' }}
            className="mo-card w-full max-w-lg shadow-2xl shadow-black/50"
            role="dialog"
            aria-modal="true"
            aria-label="Edit project"
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
                  Edit Project
                </div>
                <h2 className="mt-2 font-display text-[28px] font-medium leading-tight tracking-[-0.005em] text-parchment">
                  Edit <em className="font-normal italic text-brass">project</em>
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
                <label htmlFor="ep-name" className={LABEL_CLASS}>
                  Project Name
                </label>
                <input
                  id="ep-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="The Northern Survey"
                  className={`mt-2 ${FIELD_CLASS}`}
                />
              </div>

              <div>
                <span className={LABEL_CLASS}>
                  Project Directories <span className="text-sand-dim">(reference)</span>
                </span>
                <div className="mt-2 space-y-2">
                  {directories.length === 0 && (
                    <p className="font-display text-[13px] italic text-sand-dim">
                      No directories yet — add one below.
                    </p>
                  )}
                  {directories.map((d, i) => {
                    const isDragOver =
                      dragOverIndex === i && draggingIndex !== null && draggingIndex !== i
                    return (
                    <div
                      key={i}
                      onDragOver={(e) => {
                        if (draggingIndex === null) return
                        e.preventDefault()
                        if (dragOverIndex !== i) setDragOverIndex(i)
                      }}
                      onDragLeave={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                          setDragOverIndex((cur) => (cur === i ? null : cur))
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault()
                        if (draggingIndex !== null) reorderDir(draggingIndex, i)
                        setDraggingIndex(null)
                        setDragOverIndex(null)
                      }}
                      className={`border p-2.5 transition-colors duration-150 ${
                        isDragOver ? 'border-brass bg-brass/5' : 'border-hairline-s'
                      } ${draggingIndex === i ? 'opacity-40' : ''}`}
                    >
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          draggable
                          onDragStart={(e) => {
                            setDraggingIndex(i)
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          onDragEnd={() => {
                            setDraggingIndex(null)
                            setDragOverIndex(null)
                          }}
                          title="Drag to reorder"
                          aria-label="Drag to reorder directory"
                          className="flex h-9 w-5 shrink-0 cursor-grab items-center justify-center text-sand-dim transition-colors duration-150 hover:text-brass active:cursor-grabbing"
                        >
                          <GripVertical className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <input
                          type="text"
                          value={d.path}
                          onChange={(e) => setDirPath(i, e.target.value)}
                          placeholder="C:\Users\you\projects\survey"
                          spellCheck={false}
                          className="min-w-0 flex-1 border border-hairline bg-transparent px-3 py-2.5 font-mono text-[12px] text-parchment placeholder:text-sand-dim outline-none transition-colors duration-200 focus:border-brass"
                        />
                        <button
                          type="button"
                          onClick={() => setPickerRow(i)}
                          title="Browse…"
                          aria-label="Browse for a folder"
                          className="mo-ticks flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand transition-colors duration-150 hover:border-brass hover:text-brass"
                        >
                          <FolderSearch className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeDir(i)}
                          title="Remove"
                          aria-label="Remove directory"
                          className="mo-ticks flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand transition-colors duration-150 hover:border-[#cf6b52] hover:text-[#cf6b52]"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                      {/* terminal commands — zero or more per directory */}
                      <div className="mt-2 space-y-2 pl-7">
                        {d.commands.map((cmd, ci) => (
                          <div key={ci} className="flex items-center gap-2">
                            <Terminal
                              className="h-3.5 w-3.5 shrink-0 text-sand-dim"
                              aria-hidden="true"
                            />
                            <input
                              type="text"
                              value={cmd}
                              onChange={(e) => setDirCommand(i, ci, e.target.value)}
                              placeholder="Terminal command — e.g. npm run dev"
                              spellCheck={false}
                              className="min-w-0 flex-1 border border-hairline bg-transparent px-3 py-2 font-mono text-[11px] text-parchment placeholder:text-sand-dim outline-none transition-colors duration-200 focus:border-brass"
                            />
                            <button
                              type="button"
                              onClick={() => removeCommand(i, ci)}
                              title="Remove command"
                              aria-label="Remove command"
                              className="mo-ticks flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center border border-hairline text-sand transition-colors duration-150 hover:border-[#cf6b52] hover:text-[#cf6b52]"
                            >
                              <Trash2 className="h-3 w-3" aria-hidden="true" />
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => addCommand(i)}
                          className="mo-ticks flex cursor-pointer items-center gap-1.5 border border-hairline px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-sand transition-colors duration-150 hover:border-brass hover:text-brass"
                        >
                          <Plus className="h-3 w-3" aria-hidden="true" />
                          Add command
                        </button>
                      </div>
                    </div>
                    )
                  })}
                </div>
                <button
                  type="button"
                  onClick={addDir}
                  className="mo-ticks mt-2 flex cursor-pointer items-center gap-2 border border-hairline px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:border-brass hover:text-brass"
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  Add directory
                </button>
                <p className="mt-2 font-display text-[12px] italic leading-relaxed text-sand">
                  Folders you associate with this project — separate from the global{' '}
                  <span className="font-mono not-italic text-sand-dim">.claude</span> config dir.
                  Each can carry one or more terminal commands to run in that directory (quick-launches
                  saved on the project), and you can drag the grip to reorder. These are labels /
                  shortcuts; they don't change where chats run.
                </p>
              </div>

              <div>
                <label htmlFor="ep-desc" className={LABEL_CLASS}>
                  Description
                </label>
                <textarea
                  id="ep-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this project is, links, reminders…"
                  rows={3}
                  className={`mt-2 resize-y ${FIELD_CLASS}`}
                />
              </div>

              <div>
                <span className={LABEL_CLASS}>Color Label</span>
                <div className="mt-2 flex items-center gap-2.5">
                  <button
                    type="button"
                    aria-label="No color"
                    aria-pressed={color === ''}
                    onClick={() => setColor('')}
                    className={`flex h-6 w-6 cursor-pointer items-center justify-center border text-[10px] transition-colors duration-150 ${
                      color === '' ? 'border-brass text-brass' : 'border-hairline text-sand-dim hover:border-sand'
                    }`}
                  >
                    ✕
                  </button>
                  {PROJECT_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Color ${c}`}
                      aria-pressed={color === c}
                      onClick={() => setColor(c)}
                      style={{ background: c }}
                      className={`h-6 w-6 cursor-pointer rounded-full ring-offset-2 ring-offset-[var(--color-surface)] transition-shadow duration-150 ${
                        color === c ? 'ring-2 ring-brass' : 'ring-1 ring-hairline hover:ring-sand'
                      }`}
                    />
                  ))}
                </div>
              </div>

              {error !== null && (
                <p
                  role="alert"
                  className="border border-brass px-4 py-3 font-mono text-[11px] uppercase tracking-[0.16em] text-brass"
                >
                  {error}
                </p>
              )}

              <div className="flex justify-end gap-3 border-t border-hairline-s pt-5">
                <button
                  type="button"
                  onClick={onClose}
                  className="mo-ticks cursor-pointer border border-hairline px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="mo-button disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    <FolderPicker
      open={pickerRow !== null}
      initialPath={pickerRow !== null ? directories[pickerRow]?.path : ''}
      onPick={(p) => {
        if (pickerRow !== null) setDirPath(pickerRow, p)
        setPickerRow(null)
      }}
      onClose={() => setPickerRow(null)}
    />
    </>
  )
}

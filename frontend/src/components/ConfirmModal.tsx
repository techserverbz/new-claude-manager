import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, X } from 'lucide-react'

/**
 * ConfirmModal — a small destructive-action confirmation. Solid plate over a
 * scrim, matching the other modals (.mo-card is transparent, so we force an
 * opaque surface inline). The confirm button is warm-rust to read as danger.
 */
export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onClose: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Enter') {
        onConfirm()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, onConfirm])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.22, ease: 'easeOut' } }}
          exit={{ opacity: 0, transition: { duration: 0.16, ease: 'easeIn' } }}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-midnight/70 px-6"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.2, 0.6, 0.2, 1] } }}
            exit={{ opacity: 0, y: 6, transition: { duration: 0.16, ease: 'easeIn' } }}
            style={{ background: 'var(--color-surface)' }}
            className="mo-card w-full max-w-sm shadow-2xl shadow-black/50"
            role="alertdialog"
            aria-modal="true"
            aria-label={title}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: '#cf6b52' }} aria-hidden="true" />
                <h2 className="font-display text-[20px] font-medium leading-tight tracking-[-0.005em] text-parchment">
                  {title}
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="mo-ticks flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center border border-transparent text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <p className="mt-3 font-display text-[14px] italic leading-relaxed text-sand">{message}</p>

            <div className="mt-5 flex justify-end gap-3 border-t border-hairline-s pt-4">
              <button
                type="button"
                onClick={onClose}
                className="mo-ticks cursor-pointer border border-hairline px-4 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  onConfirm()
                  onClose()
                }}
                style={{ background: '#cf6b52', color: 'var(--color-midnight)' }}
                className="cursor-pointer px-4 py-2 font-mono text-[11px] uppercase tracking-[0.16em] transition-opacity duration-200 hover:opacity-90"
              >
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

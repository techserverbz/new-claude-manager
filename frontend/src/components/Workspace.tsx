import { useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { motion } from 'framer-motion'
import {
  Check,
  ChevronDown,
  Grid2x2,
  Layers,
  Moon,
  Pencil,
  PenTool,
  Plus,
  RefreshCw,
  Square,
  Sun,
  TerminalSquare,
  X,
} from 'lucide-react'
import type { DefaultView, PaneMode, SavedView, Theme, WorkTab } from '../App'
import type { Project } from '../lib/api'
import { CelestialSphere } from './CelestialSphere'
import { SessionPane } from './SessionPane'

/**
 * Workspace — the TAB + MULTIPANE shell.
 *
 * A horizontal tab strip (one button per open session) sits above the content
 * floor. Each tab shows a status dot — filled brass when it is the active tab,
 * the green `.mo-live-dot` when that session's shell is running — its title, and
 * a close ×. Right after the tabs, a window-count picker (1–6) chooses how many
 * panes show side by side as equal-width columns; a sliding window of that many
 * tabs (always including the active one) is shown.
 *
 * CRITICAL: every open tab's SessionPane stays MOUNTED whatever the count so the
 * terminals (pty) and chat streams survive tab switches AND count changes. Tabs
 * outside the visible window are hidden via `invisible` + absolute, never
 * unmounted — the same keep-alive strategy the terminal pool uses internally.
 */

export function Workspace({
  openTabs,
  activeTabKey,
  paneMode,
  windowCount,
  theme,
  onToggleTheme,
  projects,
  defaultView,
  viewRequest,
  liveSessionIds,
  shellRefresh,
  reconnectAllSignal,
  onRefreshAllChats,
  onSelectTab,
  onCloseTab,
  onReorderTabs,
  onSetPaneMode,
  onSetWindowCount,
  views,
  onSaveView,
  onLoadView,
  onUpdateView,
  onDeleteView,
  onRenameView,
  onSessionIdChange,
  onActiveSessionsChange,
  onNewProject,
  canvasSplit,
}: {
  openTabs: WorkTab[]
  activeTabKey: string | null
  /** single pane vs multi pane */
  paneMode: PaneMode
  /** how many panes when multi (2–6) */
  windowCount: number
  /** saved layouts (named views) */
  views: SavedView[]
  onSaveView: () => void
  onLoadView: (id: string) => void
  onUpdateView: (id: string) => void
  onDeleteView: (id: string) => void
  onRenameView: (id: string, name: string) => void
  theme: Theme
  onToggleTheme: () => void
  projects: Project[]
  /** which sub-view a freshly opened pane lands on (persisted preference) */
  defaultView: DefaultView
  /** explicit "show this session in this view" request (right-click → Chat view) */
  viewRequest?: { sessionId: string; view: DefaultView; nonce: number } | null
  /** session ids whose shell is live — drives the green tab dots */
  liveSessionIds: string[]
  /** bumps when a focused shell should re-resume on view (after a chat turn) */
  shellRefresh: number
  /** bumps from the global "refresh all chats" button — reconnects every pane's
      shell and re-reads every chat log (forwarded to all SessionPanes) */
  reconnectAllSignal: number
  /** invoked by the "refresh all chats" button — App bumps reconnectAllSignal
      and force-reconnects the shared chat socket */
  onRefreshAllChats: () => void
  onSelectTab: (key: string) => void
  onCloseTab: (key: string) => void
  /** drag-rearrange: swap the two windows' slot positions */
  onReorderTabs: (fromKey: string, toKey: string) => void
  onSetPaneMode: (mode: PaneMode) => void
  onSetWindowCount: (n: number) => void
  onSessionIdChange: (key: string, sessionId: string) => void
  /** a pane reported its connected session ids — keyed per tab, merged by App */
  onActiveSessionsChange: (key: string, ids: string[]) => void
  onNewProject: () => void
  /** the canvas is open beside the panes (split) — glow the focused pane even
      when there's only one, so it reads as the active half */
  canvasSplit?: boolean
}) {
  const liveSet = new Set(liveSessionIds)
  const projectById = (id: string): Project | null => projects.find((p) => p.id === id) ?? null
  /* brief spin feedback on the "refresh all chats" button so the click registers */
  const [refreshSpin, setRefreshSpin] = useState(false)
  const refreshSpinTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(refreshSpinTimer.current), [])
  const handleRefreshClick = () => {
    onRefreshAllChats()
    setRefreshSpin(true)
    window.clearTimeout(refreshSpinTimer.current)
    refreshSpinTimer.current = window.setTimeout(() => setRefreshSpin(false), 700)
  }
  /* the strip + the empty floor key off REAL tabs only — empty slots are layout,
     not conversations */
  const realTabs = openTabs.filter((t) => t.empty !== true)
  const hasTabs = openTabs.length > 0

  /* bump on every layout-size change (single↔multi, window-count, canvas split)
     so each pane's terminal refits to its new width — xterm's own ResizeObserver
     can miss a fast reflow and leave the grid garbled until a reload. */
  const [paneResizeNonce, setPaneResizeNonce] = useState(0)
  useEffect(() => {
    setPaneResizeNonce((n) => n + 1)
  }, [paneMode, windowCount, canvasSplit])

  /* the windows dropdown (count select, used in multi mode) */
  const [winOpen, setWinOpen] = useState(false)
  const winWrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!winOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (winWrapRef.current !== null && !winWrapRef.current.contains(e.target as Node)) {
        setWinOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWinOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [winOpen])

  /* the views dropdown (saved layouts) + inline rename of a view */
  const [viewsOpen, setViewsOpen] = useState(false)
  const [viewsModalOpen, setViewsModalOpen] = useState(false)
  const [editViewId, setEditViewId] = useState<string | null>(null)
  const [viewDraft, setViewDraft] = useState('')
  const viewsWrapRef = useRef<HTMLDivElement>(null)
  const startRenameView = (id: string, current: string) => {
    setEditViewId(id)
    setViewDraft(current)
  }
  const commitRenameView = () => {
    if (editViewId !== null) onRenameView(editViewId, viewDraft)
    setEditViewId(null)
  }
  useEffect(() => {
    if (!viewsOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (viewsWrapRef.current !== null && !viewsWrapRef.current.contains(e.target as Node)) {
        setViewsOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewsOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [viewsOpen])

  /* SLOT model: single mode = the active real tab full (1 column); multi mode =
     EVERY entry in openTabs is a real, stable slot (a conversation or an EMPTY
     placeholder), so the row is exactly `windowCount` columns with no sliding —
     each position is shown side by side. cols>1 enables the per-pane brass ring.
     In single mode only the active real tab shows; the other reals stay mounted
     but hidden so their pty + chat stream survive a tab switch. */
  const cols = paneMode === 'single' ? 1 : windowCount

  /* — drag-to-rearrange (multi, >1 slot): a header grip starts the drag, every
       slot is a drop target; dropping swaps the two slot positions — */
  const draggingKeyRef = useRef<string | null>(null)
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const canReorder = paneMode === 'multi' && openTabs.length > 1
  /* the TOP tab strip is draggable whenever there's more than one real tab —
     in single mode too (the multipane column reorder above keys off canReorder). */
  const canReorderTabs = realTabs.length > 1

  const handleDragStart = (key: string) => (e: DragEvent) => {
    draggingKeyRef.current = key
    setDraggingKey(key)
    e.dataTransfer.effectAllowed = 'move'
    try {
      e.dataTransfer.setData('text/plain', key)
    } catch {
      /* some engines disallow setData here */
    }
  }
  const handleDragEnd = () => {
    draggingKeyRef.current = null
    setDraggingKey(null)
    setDragOverKey(null)
  }
  const dropTargetProps = (key: string) => ({
    onDragOver: (e: DragEvent) => {
      if (draggingKeyRef.current === null) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (dragOverKey !== key) setDragOverKey(key)
    },
    onDragLeave: () => {
      setDragOverKey((cur) => (cur === key ? null : cur))
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      const from = draggingKeyRef.current
      if (from !== null && from !== key) onReorderTabs(from, key)
      handleDragEnd()
    },
  })
  const dragHandleProps = (key: string) => ({
    draggable: true,
    onDragStart: handleDragStart(key),
    onDragEnd: handleDragEnd,
  })

  return (
    <>
    <main className="relative flex min-w-0 flex-1 flex-col">
      {/* — tab strip — */}
      <nav
        className="flex items-stretch border-b border-hairline"
        aria-label="Open sessions"
        role="tablist"
      >
        <div className="no-scrollbar flex min-w-0 items-stretch overflow-x-auto">
          {realTabs.map((t) => {
            const isActive = t.key === activeTabKey
            const isLive = t.sessionId !== null && liveSet.has(t.sessionId)
            const isTabDragging = draggingKey === t.key
            const isTabDragOver =
              canReorderTabs && dragOverKey === t.key && draggingKey !== null && draggingKey !== t.key
            return (
              <div
                key={t.key}
                role="tab"
                aria-selected={isActive}
                {...(canReorderTabs ? dragHandleProps(t.key) : {})}
                {...(canReorderTabs ? dropTargetProps(t.key) : {})}
                className={`group relative flex max-w-[220px] shrink-0 items-center gap-2 border-r border-hairline pl-3.5 pr-2 transition-opacity duration-150 ${
                  isActive ? 'text-brass' : 'text-sand'
                } ${canReorderTabs ? 'cursor-grab active:cursor-grabbing' : ''} ${
                  isTabDragging ? 'opacity-40' : ''
                } ${isTabDragOver ? 'bg-brass/12' : ''}`}
              >
                {isTabDragOver && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-brass"
                  />
                )}
                <button
                  type="button"
                  onClick={() => onSelectTab(t.key)}
                  className="flex min-w-0 cursor-pointer items-center gap-2 py-3.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors duration-200 hover:text-brass"
                >
                  {/* status dot: filled brass when active, green live dot when
                      the shell is running, else a faint hollow ring */}
                  <span
                    aria-hidden={isLive ? undefined : true}
                    className="flex h-[7px] w-[7px] shrink-0 items-center justify-center"
                  >
                    {isLive ? (
                      <span className="mo-live-dot" role="img" aria-label="Live shell running" />
                    ) : isActive ? (
                      <span className="h-[7px] w-[7px] rounded-full bg-brass" />
                    ) : (
                      <span className="h-[6px] w-[6px] rounded-full border border-sand-dim" />
                    )}
                  </span>
                  <span className="min-w-0 truncate">{t.title}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onCloseTab(t.key)}
                  aria-label={`Close ${t.title}`}
                  className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center text-sand-dim transition-colors duration-200 hover:text-brass"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
                {isActive && (
                  <motion.span
                    layoutId="tab-underline"
                    aria-hidden="true"
                    className="absolute inset-x-0 -bottom-px h-px bg-brass"
                    transition={{ duration: 0.35, ease: [0.2, 0.6, 0.2, 1] }}
                  />
                )}
              </div>
            )
          })}
        </div>

        {/* — pane mode (single | multi) + window-count select — */}
        <div className="flex shrink-0 items-center gap-2 pl-2">
          {/* single | multi toggle */}
          <div role="group" aria-label="Pane mode" className="flex items-center border border-hairline">
            <button
              type="button"
              onClick={() => onSetPaneMode('single')}
              aria-pressed={paneMode === 'single'}
              aria-label="Single pane"
              className={`flex h-8 w-8 cursor-pointer items-center justify-center transition-colors duration-200 ${
                paneMode === 'single' ? 'bg-brass text-midnight' : 'text-sand hover:text-brass'
              }`}
            >
              <Square className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onSetPaneMode('multi')}
              aria-pressed={paneMode === 'multi'}
              aria-label="Multi pane"
              className={`flex h-8 w-8 cursor-pointer items-center justify-center border-l border-hairline transition-colors duration-200 ${
                paneMode === 'multi' ? 'bg-brass text-midnight' : 'text-sand hover:text-brass'
              }`}
            >
              <Grid2x2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          {/* number-of-windows select — active in multi mode */}
          <div className="relative" ref={winWrapRef}>
            <button
              type="button"
              onClick={() => setWinOpen((o) => !o)}
              disabled={paneMode === 'single'}
              aria-haspopup="listbox"
              aria-expanded={winOpen}
              aria-label="Number of windows"
              className="flex h-8 cursor-pointer items-center gap-1.5 border border-hairline px-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-sand transition-colors duration-200 hover:text-brass disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-sand"
            >
              {windowCount} <span className="hidden sm:inline">windows</span>
              <ChevronDown
                className={`h-3 w-3 transition-transform duration-200 ${winOpen ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </button>
            {winOpen && paneMode === 'multi' && (
              <div
                role="listbox"
                aria-label="Number of windows"
                className="absolute right-0 top-[calc(100%+4px)] z-20 min-w-[7rem] border border-hairline bg-surface py-1 shadow-lg shadow-black/30"
              >
                {[2, 3, 4, 5, 6].map((n) => {
                  const sel = windowCount === n
                  return (
                    <button
                      key={n}
                      type="button"
                      role="option"
                      aria-selected={sel}
                      onClick={() => {
                        onSetWindowCount(n)
                        setWinOpen(false)
                      }}
                      className={`block w-full cursor-pointer px-3 py-1.5 text-left font-mono text-[10px] uppercase tracking-[0.16em] transition-colors duration-150 ${
                        sel ? 'bg-brass text-midnight' : 'text-sand hover:bg-surface-2/50 hover:text-brass'
                      }`}
                    >
                      {n} windows
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* saved views (named layouts) */}
          <div className="relative" ref={viewsWrapRef}>
            <button
              type="button"
              onClick={() => setViewsOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={viewsOpen}
              aria-label="Saved views"
              className="flex h-8 cursor-pointer items-center gap-1.5 border border-hairline px-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-sand transition-colors duration-200 hover:text-brass"
            >
              <Layers className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">views</span>
              {views.length > 0 && <span className="text-sand-dim">{views.length}</span>}
              <ChevronDown
                className={`h-3 w-3 transition-transform duration-200 ${viewsOpen ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </button>
            {viewsOpen && (
              <div
                role="menu"
                aria-label="Saved views"
                className="absolute right-0 top-[calc(100%+4px)] z-20 min-w-[15rem] border border-hairline bg-surface py-1 shadow-lg shadow-black/30"
              >
                {views.length === 0 ? (
                  <p className="px-3 py-2 font-display text-[13px] italic leading-snug text-sand-dim">
                    No saved views yet. Arrange your windows, then save this layout.
                  </p>
                ) : (
                  views.map((v) =>
                    editViewId === v.id ? (
                      <div key={v.id} className="px-1.5 py-1">
                        <input
                          autoFocus
                          value={viewDraft}
                          spellCheck={false}
                          onChange={(e) => setViewDraft(e.target.value)}
                          onBlur={commitRenameView}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              commitRenameView()
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              setEditViewId(null)
                            }
                          }}
                          aria-label="Rename view"
                          className="w-full border border-brass bg-surface-2 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-parchment outline-none"
                        />
                      </div>
                    ) : (
                      <div
                        key={v.id}
                        className="group flex items-center gap-1 px-1.5 hover:bg-surface-2/50"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            onLoadView(v.id)
                            setViewsOpen(false)
                          }}
                          onDoubleClick={() => startRenameView(v.id, v.name)}
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 pl-1.5 text-left font-mono text-[10px] uppercase tracking-[0.16em] text-sand transition-colors duration-150 group-hover:text-brass"
                          title="Load this layout (double-click to rename)"
                        >
                          <Layers className="h-3 w-3 shrink-0" aria-hidden="true" />
                          <span className="truncate">{v.name}</span>
                          {v.canvasFile && (
                            <PenTool className="h-3 w-3 shrink-0 text-brass" aria-label="includes canvas" />
                          )}
                          <span className="shrink-0 text-[9px] text-sand-dim">
                            {v.paneMode === 'single' ? '1' : v.windowCount}w
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => startRenameView(v.id, v.name)}
                          aria-label={`Rename ${v.name}`}
                          title="Rename view"
                          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-sand-dim opacity-0 transition-colors duration-150 hover:text-brass group-hover:opacity-100"
                        >
                          <Pencil className="h-3 w-3" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onUpdateView(v.id)}
                          aria-label={`Update ${v.name} to current layout`}
                          title="Overwrite with current layout"
                          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-sand-dim opacity-0 transition-colors duration-150 hover:text-brass group-hover:opacity-100"
                        >
                          <Check className="h-3 w-3" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteView(v.id)}
                          aria-label={`Delete ${v.name}`}
                          title="Delete view"
                          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-sand-dim opacity-0 transition-colors duration-150 hover:text-brass group-hover:opacity-100"
                        >
                          <X className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </div>
                    ),
                  )
                )}
                <button
                  type="button"
                  onClick={() => {
                    onSaveView()
                    setViewsOpen(false)
                  }}
                  className="mt-1 flex w-full cursor-pointer items-center gap-2 border-t border-hairline-s px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.16em] text-brass transition-colors duration-150 hover:bg-surface-2/50"
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  Save current view
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setViewsModalOpen(true)
                    setViewsOpen(false)
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.16em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
                >
                  <Layers className="h-3 w-3" aria-hidden="true" />
                  Open all views
                </button>
              </div>
            )}
          </div>
        </div>

        {/* — refresh all chats + theme: pinned to the far right — */}
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-3 pr-4">
          {/* reconnect every pane's shell + re-read every chat log, without a
              full page reload — recovers chat UIs that reset after the browser
              suspended/moved the tab */}
          <button
            type="button"
            onClick={handleRefreshClick}
            aria-label="Refresh all chats"
            title="Refresh all chats — reconnect every shell and reload its log"
            className="mo-ticks flex h-10 w-10 cursor-pointer items-center justify-center border border-transparent text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
          >
            <RefreshCw
              className={`h-4 w-4 ${refreshSpin ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            className="mo-ticks flex h-10 w-10 cursor-pointer items-center justify-center border border-transparent text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
          >
            {theme === 'dark' ? (
              <Sun className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Moon className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </nav>

      {/* — content floor — */}
      <div className="relative flex-1 overflow-hidden">
        {!hasTabs ? (
          <EmptyFloor theme={theme} onNewProject={onNewProject} />
        ) : (
          /* a horizontal row of equal-width COLUMNS — one per slot in openTabs.
             In MULTI every slot (real OR empty) is a fixed position shown side by
             side. In SINGLE only the active real tab is visible; the rest stay
             mounted but hidden (absolute + invisible) so their pty + chat survive.
             Columns share width evenly but never shrink below a readable min,
             beyond which the row scrolls. The focused slot carries the brass ring
             (real or empty); a clicked empty slot fills with the next session. */
          <div className="no-scrollbar flex h-full gap-px overflow-x-auto overflow-y-hidden bg-hairline">
            {openTabs.map((t) => {
              const isFocused = t.key === activeTabKey
              /* single: only the active real tab is on-screen; multi: all slots */
              const isVisible = paneMode === 'multi' || isFocused
              /* every pane is bordered (hairline); the focused one warms to brass */
              const ringClass =
                isFocused && cols > 1
                  ? 'z-10 ring-2 ring-inset ring-brass'
                  : 'ring-1 ring-inset ring-hairline'
              const isDragging = draggingKey === t.key
              const isDropTarget =
                canReorder && dragOverKey === t.key && draggingKey !== null && draggingKey !== t.key
              const dropOverlay = isDropTarget ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 z-30 bg-brass/10 ring-2 ring-inset ring-brass"
                />
              ) : null

              /* — EMPTY slot: a clickable, focusable, draggable placeholder column — */
              if (t.empty === true) {
                return (
                  <div
                    key={t.key}
                    role="button"
                    tabIndex={0}
                    aria-label={isFocused ? 'Focused empty window' : 'Empty window'}
                    onPointerDownCapture={() => {
                      if (!isFocused) onSelectTab(t.key)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSelectTab(t.key)
                      }
                    }}
                    {...(canReorder ? dragHandleProps(t.key) : {})}
                    {...(canReorder ? dropTargetProps(t.key) : {})}
                    className={`relative flex min-h-0 min-w-[300px] flex-1 basis-0 cursor-pointer flex-col items-center justify-center gap-3 bg-surface px-6 text-center ${ringClass} ${
                      isDragging ? 'opacity-40' : ''
                    }`}
                  >
                    <TerminalSquare
                      className={`h-5 w-5 ${isFocused ? 'text-brass' : 'text-sand-dim'}`}
                      aria-hidden="true"
                    />
                    <p
                      className={`max-w-[16rem] font-display text-[14px] italic leading-relaxed ${
                        isFocused ? 'text-brass' : 'text-sand-dim'
                      }`}
                    >
                      {isFocused
                        ? 'Focused — pick a conversation from the rail to fill this window.'
                        : 'Empty window — pick a conversation from the rail to fill it.'}
                    </p>
                    {dropOverlay}
                  </div>
                )
              }

              /* — REAL slot: its SessionPane column. The drag GRIP lives in the
                   pane header (so the terminal stays interactive); the wrapper is
                   the drop target. — */
              return (
                <div
                  key={t.key}
                  onPointerDownCapture={() => {
                    if (!isFocused) onSelectTab(t.key)
                  }}
                  {...(canReorder && isVisible ? dropTargetProps(t.key) : {})}
                  aria-hidden={isVisible ? undefined : true}
                  className={
                    isVisible
                      ? `relative min-h-0 min-w-[300px] flex-1 basis-0 bg-surface ${
                          isDragging ? 'opacity-40' : ''
                        }`
                      : 'invisible absolute inset-0 bg-surface'
                  }
                >
                  <SessionPane
                    project={projectById(t.projectId)}
                    sessionId={t.sessionId}
                    theme={theme}
                    defaultView={defaultView}
                    viewRequest={viewRequest}
                    shellRefresh={shellRefresh}
                    resizeSignal={paneResizeNonce}
                    reconnectAllSignal={reconnectAllSignal}
                    isFocused={isFocused}
                    dragHandleProps={canReorder ? dragHandleProps(t.key) : undefined}
                    onSessionIdChange={(sid) => onSessionIdChange(t.key, sid)}
                    onActiveSessionsChange={(ids) => onActiveSessionsChange(t.key, ids)}
                    onClose={() => onCloseTab(t.key)}
                  />
                  {/* border drawn as an OVERLAY above the pane content — an inset
                      ring on the wrapper gets painted over by the terminal, so
                      EVERY pane gets a hairline border here and the focused one
                      warms to a brass ring. */}
                  {isVisible && (cols > 1 || canvasSplit) && (
                    <div
                      aria-hidden="true"
                      className={
                        isFocused
                          ? 'pointer-events-none absolute inset-0 z-20 ring-2 ring-inset ring-brass'
                          : 'pointer-events-none absolute inset-0 z-10 ring-1 ring-inset ring-hairline'
                      }
                    />
                  )}
                  {dropOverlay}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </main>

    {/* — "All views" modal: a roomy manager for saved views — */}
    {viewsModalOpen && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-midnight/70 px-6"
        onClick={() => setViewsModalOpen(false)}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="All views"
          style={{ background: 'var(--color-surface)' }}
          className="mo-card flex max-h-[80vh] w-full max-w-lg flex-col shadow-2xl shadow-black/50"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
                <span className="text-brass" aria-hidden="true">
                  ✦
                </span>{' '}
                Views
              </div>
              <h2 className="mt-2 font-display text-[24px] font-medium leading-tight text-parchment">
                All views
              </h2>
            </div>
            <button
              type="button"
              onClick={() => setViewsModalOpen(false)}
              aria-label="Close"
              className="mo-ticks flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center border border-transparent text-sand transition-colors duration-200 hover:border-brass hover:text-brass"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="no-scrollbar mt-5 min-h-0 flex-1 overflow-y-auto border-t border-hairline-s pt-3">
            {views.length === 0 ? (
              <p className="px-1 py-2 font-display text-[14px] italic leading-relaxed text-sand-dim">
                No saved views yet. Arrange your windows (and canvas), then save this layout.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {views.map((v) =>
                  editViewId === v.id ? (
                    <li key={v.id}>
                      <input
                        autoFocus
                        value={viewDraft}
                        spellCheck={false}
                        onChange={(e) => setViewDraft(e.target.value)}
                        onBlur={commitRenameView}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            commitRenameView()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            setEditViewId(null)
                          }
                        }}
                        aria-label="Rename view"
                        className="w-full border border-brass bg-surface-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-parchment outline-none"
                      />
                    </li>
                  ) : (
                    <li
                      key={v.id}
                      className="group flex items-center gap-1 border border-hairline-s px-1.5 transition-colors duration-150 hover:bg-surface-2/40"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onLoadView(v.id)
                          setViewsModalOpen(false)
                        }}
                        onDoubleClick={() => startRenameView(v.id, v.name)}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2.5 pl-1.5 text-left font-mono text-[11px] uppercase tracking-[0.14em] text-sand transition-colors duration-150 group-hover:text-brass"
                        title="Load this layout (double-click to rename)"
                      >
                        <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span className="truncate">{v.name}</span>
                        {v.canvasFile && (
                          <PenTool className="h-3 w-3 shrink-0 text-brass" aria-label="includes canvas" />
                        )}
                        <span className="shrink-0 text-[9px] text-sand-dim">
                          {v.paneMode === 'single' ? '1' : v.windowCount}w{v.canvasFile ? ' + canvas' : ''}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => startRenameView(v.id, v.name)}
                        aria-label={`Rename ${v.name}`}
                        title="Rename"
                        className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center text-sand-dim transition-colors duration-150 hover:text-brass"
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onUpdateView(v.id)}
                        aria-label={`Update ${v.name} to current layout`}
                        title="Overwrite with current layout"
                        className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center text-sand-dim transition-colors duration-150 hover:text-brass"
                      >
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteView(v.id)}
                        aria-label={`Delete ${v.name}`}
                        title="Delete"
                        className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center text-sand-dim transition-colors duration-150 hover:text-[#cf6b52]"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </li>
                  ),
                )}
              </ul>
            )}
          </div>

          <div className="mt-4 flex justify-end border-t border-hairline-s pt-4">
            <button
              type="button"
              onClick={() => onSaveView()}
              className="mo-button flex items-center gap-2"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Save current view
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}

/* — the global empty floor: shown when no tabs are open — */
function EmptyFloor({ theme, onNewProject }: { theme: Theme; onNewProject: () => void }) {
  return (
    <section
      aria-label="No sessions open"
      className="relative flex min-h-full flex-col items-center justify-center overflow-y-auto px-8 py-12 text-center"
    >
      {/* — celestial frame: crosshair sweep + corner ticks — */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-px w-[70%] -translate-x-1/2 -translate-y-1/2 bg-hairline-s"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[70%] w-px -translate-x-1/2 -translate-y-1/2 bg-hairline-s"
      />
      {(
        [
          ['α · 01', 'left-6 top-6'],
          ['β · 02', 'right-6 top-6'],
          ['γ · 03', 'bottom-6 left-6'],
          ['δ · 04', 'bottom-6 right-6'],
        ] as const
      ).map(([tick, pos]) => (
        <span
          key={tick}
          aria-hidden="true"
          className={`pointer-events-none absolute ${pos} font-mono text-[9px] uppercase tracking-[0.24em] text-sand-dim`}
        >
          {tick}
        </span>
      ))}
      <div className="mb-7 flex items-center justify-center gap-3.5 font-mono text-[10px] uppercase tracking-[0.3em] text-sand">
        <span className="h-px w-9 bg-hairline" aria-hidden="true" />
        <span className="text-brass" aria-hidden="true">
          ✦
        </span>
        <span>№ 01 · Observatory</span>
        <span className="text-brass" aria-hidden="true">
          ✦
        </span>
        <span className="h-px w-9 bg-hairline" aria-hidden="true" />
      </div>

      <div className="relative mb-8 flex items-center justify-center">
        <div
          aria-hidden="true"
          className="absolute h-[min(360px,80vw)] w-[min(360px,80vw)] rounded-full border border-hairline-s"
        />
        <div
          aria-hidden="true"
          className="absolute h-[min(275px,61vw)] w-[min(275px,61vw)] rounded-full border border-hairline-s"
        />
        <div
          aria-hidden="true"
          className="absolute h-[min(190px,42vw)] w-[min(190px,42vw)] rounded-full border border-hairline-s"
        />
        <div aria-hidden="true" className="mo-sphere-glow absolute h-[320px] w-[320px]" />
        <CelestialSphere size={280} theme={theme} />
      </div>

      <h2
        className="font-display font-medium tracking-[-0.005em] text-parchment"
        style={{ fontSize: 'clamp(40px, 5vw, 72px)', lineHeight: 1.0 }}
      >
        The floor{' '}
        <em className="mo-halo font-normal italic text-brass">stands ready</em>
      </h2>

      <span className="mo-rule" aria-hidden="true" />

      <p className="mt-5 max-w-md font-display text-[17px] italic leading-relaxed text-sand">
        No sessions are open. Chart a project, then open a conversation — each one
        keeps its own tab here, side by side when you split the floor.
      </p>

      <button type="button" onClick={onNewProject} className="mo-button mt-9">
        Chart a Project
      </button>
    </section>
  )
}

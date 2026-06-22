import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent, MouseEvent as ReactMouseEvent } from 'react'
import { Check, ChevronRight, FolderInput, FolderPlus, PenLine, Pencil, Trash2 } from 'lucide-react'
import { SidebarRow } from './SidebarRow'
import { api, relativeTime } from '../lib/api'
import type { CanvasFile, CanvasGroup } from '../lib/api'

/**
 * Clamp a cursor-positioned (position: fixed) context menu so it never spills
 * past the viewport — a right-click near the bottom/right edge would otherwise
 * run the menu off the page. Runs in a layout effect (after the menu mounts at
 * the raw cursor coords, before paint) so the very first frame is already
 * corrected — no visible jump. Writes left/top straight to the element; React
 * re-applies the raw coords on the next open, which re-triggers this.
 */
function useClampMenuToViewport(
  ref: { current: HTMLDivElement | null },
  open: { x: number; y: number } | null,
) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!open || !el) return
    const rect = el.getBoundingClientRect()
    const pad = 8
    const x = Math.max(pad, Math.min(open.x, window.innerWidth - rect.width - pad))
    const y = Math.max(pad, Math.min(open.y, window.innerHeight - rect.height - pad))
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }, [ref, open])
}

/**
 * CanvasFilesPanel — the Canvas tab's file list, mirroring the Excalidraw app's
 * own sidebar: collapsible colored GROUPS (from the canvas /api/groups) above an
 * UNGROUPED section, drag-to-reorder (persists the global file order), a per-file
 * right-click menu (Open · Set MCP active · Move to group ▸ · Delete) and a group
 * header right-click menu (Rename · Remove). All mutations proxy to the canvas API.
 */

export function CanvasFilesPanel({
  query,
  selectedCanvas,
  onOpenCanvas,
}: {
  query: string
  selectedCanvas: string | null
  onOpenCanvas: (name: string) => void
}) {
  const [files, setFiles] = useState<CanvasFile[]>([])
  const [groups, setGroups] = useState<CanvasGroup[]>([])
  const [loaded, setLoaded] = useState(false)
  /* files whose TYPED CONTENT matches the search (not just the name) — fetched
     from the canvas server, debounced. Tagged with the exact (lowercased) query
     the set was fetched for, so a stale set from a previous query is ignored by
     matches() rather than surfacing transient false positives while typing. */
  const [contentMatches, setContentMatches] = useState<{ q: string; names: Set<string> }>({
    q: '',
    names: new Set(),
  })

  const load = useCallback(() => {
    void Promise.all([api.getCanvasFiles(), api.getCanvasGroups()])
      .then(([f, g]) => {
        setFiles(f.files)
        setGroups(g)
      })
      .catch(() => {
        /* canvas down — Sidebar shows the Start button instead */
      })
      .finally(() => setLoaded(true))
  }, [])
  useEffect(() => {
    load()
  }, [load])

  /* content search: ask the canvas server which files contain the typed text.
     Debounced so each keystroke doesn't re-scan every file; cleared when empty. */
  useEffect(() => {
    const raw = query.trim()
    if (raw === '') {
      setContentMatches({ q: '', names: new Set() })
      return
    }
    const tag = raw.toLowerCase()
    let cancelled = false
    const t = setTimeout(() => {
      void api
        .searchCanvasContent(raw)
        .then((names) => {
          if (!cancelled) setContentMatches({ q: tag, names: new Set(names) })
        })
        .catch(() => {
          if (!cancelled) setContentMatches({ q: tag, names: new Set() })
        })
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query])

  /* — context menus (fixed divs at the cursor, dismissed on any click) — */
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; name: string } | null>(null)
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [moveOpen, setMoveOpen] = useState(false)
  // keep the cursor-positioned menus from spilling past the viewport — a
  // right-click near the bottom/right edge would otherwise run off the page
  const fileMenuRef = useRef<HTMLDivElement | null>(null)
  const groupMenuRef = useRef<HTMLDivElement | null>(null)
  useClampMenuToViewport(fileMenuRef, fileMenu)
  useClampMenuToViewport(groupMenuRef, groupMenu)
  useEffect(() => {
    if (fileMenu === null && groupMenu === null) return
    const close = () => {
      setFileMenu(null)
      setGroupMenu(null)
      setMoveOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [fileMenu, groupMenu])

  /* — create / rename group (inline) — */
  const [creating, setCreating] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [creatingFile, setCreatingFile] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renamingFile, setRenamingFile] = useState<string | null>(null)
  const [renameFileValue, setRenameFileValue] = useState('')
  // guards so Enter (which unmounts the input → fires onBlur) can't double-submit
  const createGuardRef = useRef(false)
  const fileGuardRef = useRef(false)
  const renameGuardRef = useRef(false)
  const renameFileGuardRef = useRef(false)

  const doCreateFile = async () => {
    if (fileGuardRef.current) return
    fileGuardRef.current = true
    const n = newFileName.trim()
    setCreatingFile(false)
    setNewFileName('')
    if (n === '') return
    try {
      const created = await api.createCanvasFile(n)
      load()
      onOpenCanvas(created)
    } catch {
      /* ignore */
    }
  }

  const doCreateGroup = async () => {
    if (createGuardRef.current) return
    createGuardRef.current = true
    const n = newGroupName.trim()
    setCreating(false)
    setNewGroupName('')
    if (n === '') return
    try {
      await api.createCanvasGroup(n)
    } catch {
      /* ignore */
    }
    load()
  }
  const doRenameGroup = async (id: string) => {
    if (renameGuardRef.current) return
    renameGuardRef.current = true
    const n = renameValue.trim()
    setRenamingGroup(null)
    if (n === '') return
    try {
      await api.updateCanvasGroup(id, { name: n })
    } catch {
      /* ignore */
    }
    load()
  }
  const doRenameFile = async (oldName: string) => {
    if (renameFileGuardRef.current) return
    renameFileGuardRef.current = true
    const n = renameFileValue.trim()
    setRenamingFile(null)
    if (n === '' || n === oldName) return
    try {
      const newName = await api.renameCanvasFile(oldName, n)
      // if the renamed canvas is the one open, follow it to the new name
      if (selectedCanvas === oldName) onOpenCanvas(newName)
    } catch {
      /* ignore (e.g. name already taken) */
    }
    load()
  }

  /* — drag-reorder (ungrouped files; persists the global order) — */
  const dragRef = useRef<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const reorder = (from: string, to: string) => {
    if (from === to) return
    const names = files.map((f) => f.name)
    const fi = names.indexOf(from)
    const ti = names.indexOf(to)
    if (fi < 0 || ti < 0) return
    const next = [...files]
    const [moved] = next.splice(fi, 1)
    next.splice(ti, 0, moved)
    setFiles(next)
    void api.reorderCanvasFiles(next.map((f) => f.name)).catch(() => load())
  }
  const dropProps = (name: string) => ({
    draggable: true,
    isDragOver: dragOver === name,
    onDragStart: () => {
      dragRef.current = name
    },
    onDragOver: (e: DragEvent) => {
      e.preventDefault()
      if (dragOver !== name) setDragOver(name)
    },
    onDragLeave: () => setDragOver((d) => (d === name ? null : d)),
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      if (dragRef.current) reorder(dragRef.current, name)
      setDragOver(null)
      dragRef.current = null
    },
    onDragEnd: () => {
      setDragOver(null)
      dragRef.current = null
    },
  })

  /* — group mutations — */
  const moveToGroup = async (name: string, groupId: string | null) => {
    setFileMenu(null)
    setMoveOpen(false)
    try {
      if (groupId === null) {
        const cur = groups.find((g) => g.files.includes(name))
        if (cur) await api.removeCanvasFileFromGroup(cur.id, name)
      } else {
        await api.moveCanvasFileToGroup(groupId, name)
      }
    } catch {
      /* ignore */
    }
    load()
  }
  const deleteFile = async (name: string) => {
    setFileMenu(null)
    if (!window.confirm(`Delete canvas "${name}"? (a backup is kept)`)) return
    try {
      await api.deleteCanvasFile(name)
    } catch {
      /* ignore */
    }
    load()
  }
  const deleteGroup = async (id: string) => {
    setGroupMenu(null)
    if (!window.confirm('Remove this group? Its files are kept (just ungrouped).')) return
    try {
      await api.deleteCanvasGroup(id)
    } catch {
      /* ignore */
    }
    load()
  }
  const toggleCollapse = (g: CanvasGroup) => {
    setGroups((prev) => prev.map((x) => (x.id === g.id ? { ...x, collapsed: !x.collapsed } : x)))
    void api.updateCanvasGroup(g.id, { collapsed: !g.collapsed }).catch(() => load())
  }

  const openFileMenu = (e: ReactMouseEvent, name: string) => {
    e.preventDefault()
    e.stopPropagation()
    setGroupMenu(null)
    setMoveOpen(false)
    setFileMenu({ x: e.clientX, y: e.clientY, name })
  }
  const openGroupMenu = (e: ReactMouseEvent, id: string) => {
    e.preventDefault()
    e.stopPropagation()
    setFileMenu(null)
    setGroupMenu({ x: e.clientX, y: e.clientY, id })
  }

  const q = query.trim().toLowerCase()
  const nameHit = (name: string) => name.toLowerCase().includes(q)
  // a content hit only counts when the fetched set is for the CURRENT query —
  // a leftover set from the previous query (still resolving) is ignored
  const contentHit = (name: string) => contentMatches.q === q && contentMatches.names.has(name)
  // a file matches if the query is empty, its NAME contains it, or its typed
  // CONTENT contains it (from the canvas server's content search)
  const matches = (name: string) => q === '' || nameHit(name) || contentHit(name)
  const fileByName = new Map(files.map((f) => [f.name, f]))
  const groupedNames = new Set(groups.flatMap((g) => g.files))
  const ungrouped = files.filter((f) => !groupedNames.has(f.name) && matches(f.name))
  // while searching, surface the matches to the FRONT: name hits first, then
  // content-only hits (stable sort preserves the user's drag order within each
  // bucket). When not searching, the saved order is left untouched.
  if (q !== '') {
    ungrouped.sort((a, b) => (nameHit(a.name) ? 0 : 1) - (nameHit(b.name) ? 0 : 1))
  }
  // total rows actually rendered (ungrouped + the files surfaced inside groups) —
  // drives the empty-state message so a search that hits nothing still says so
  // even when groups exist (every group gets filtered out and renders nothing).
  const visibleGroupedCount = groups.reduce(
    (n, g) => n + g.files.filter((x) => fileByName.has(x)).filter(matches).length,
    0,
  )
  const totalVisible = ungrouped.length + visibleGroupedCount

  const fileRow = (name: string, i: number, drag: boolean) => {
    const meta = fileByName.get(name)
    if (renamingFile === name) {
      return (
        <li key={name}>
          <input
            autoFocus
            value={renameFileValue}
            onChange={(e) => setRenameFileValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doRenameFile(name)
              if (e.key === 'Escape') {
                renameFileGuardRef.current = true
                setRenamingFile(null)
              }
            }}
            onBlur={() => void doRenameFile(name)}
            className="w-full border border-hairline bg-transparent px-2 py-1.5 font-mono text-[11px] text-parchment outline-none focus:border-brass"
          />
        </li>
      )
    }
    return (
      <li key={name}>
        <SidebarRow
          index={i}
          nested
          title={name}
          subtitle={meta ? relativeTime(meta.modified) : ''}
          selected={name === selectedCanvas}
          onSelect={() => onOpenCanvas(name)}
          onContextMenu={(e) => openFileMenu(e, name)}
          {...(drag ? dropProps(name) : {})}
        />
      </li>
    )
  }

  return (
    <div className="mt-2">
      {/* create canvas / group */}
      {creatingFile ? (
        <input
          autoFocus
          value={newFileName}
          onChange={(e) => setNewFileName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void doCreateFile()
            if (e.key === 'Escape') {
              fileGuardRef.current = true
              setCreatingFile(false)
              setNewFileName('')
            }
          }}
          onBlur={() => void doCreateFile()}
          placeholder="New canvas name…"
          className="mb-2 w-full border border-hairline bg-transparent px-3 py-2 font-mono text-[11px] text-parchment placeholder:text-sand-dim outline-none focus:border-brass"
        />
      ) : creating ? (
        <input
          autoFocus
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void doCreateGroup()
            if (e.key === 'Escape') {
              createGuardRef.current = true // suppress the unmount-blur create
              setCreating(false)
              setNewGroupName('')
            }
          }}
          onBlur={() => void doCreateGroup()}
          placeholder="New group name…"
          className="mb-2 w-full border border-hairline bg-transparent px-3 py-2 font-mono text-[11px] text-parchment placeholder:text-sand-dim outline-none focus:border-brass"
        />
      ) : (
        <div className="mb-2 flex gap-1.5">
          <button
            type="button"
            onClick={() => {
              fileGuardRef.current = false
              setCreatingFile(true)
            }}
            className="mo-ticks flex flex-1 cursor-pointer items-center justify-center gap-1.5 border border-hairline px-2 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-sand transition-colors duration-150 hover:border-brass hover:text-brass"
          >
            <PenLine className="h-3 w-3" aria-hidden="true" />
            New canvas
          </button>
          <button
            type="button"
            onClick={() => {
              createGuardRef.current = false
              setCreating(true)
            }}
            className="mo-ticks flex flex-1 cursor-pointer items-center justify-center gap-1.5 border border-hairline px-2 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-sand transition-colors duration-150 hover:border-brass hover:text-brass"
          >
            <FolderPlus className="h-3 w-3" aria-hidden="true" />
            New group
          </button>
        </div>
      )}

      {/* groups */}
      <ul className="space-y-0 border-t border-hairline-s">
        {groups.map((g) => {
          const groupFiles = g.files.filter((n) => fileByName.has(n)).filter(matches)
          if (q !== '' && groupFiles.length === 0) return null
          const open = q !== '' ? true : !g.collapsed
          return (
            <li key={g.id}>
              {renamingGroup === g.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void doRenameGroup(g.id)
                    if (e.key === 'Escape') {
                      renameGuardRef.current = true
                      setRenamingGroup(null)
                    }
                  }}
                  onBlur={() => void doRenameGroup(g.id)}
                  className="w-full border border-hairline bg-transparent px-3 py-2 font-mono text-[11px] text-parchment outline-none focus:border-brass"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => toggleCollapse(g)}
                  onContextMenu={(e) => openGroupMenu(e, g.id)}
                  className="mo-ticks flex w-full cursor-pointer items-center gap-2 border-b border-hairline-s py-2 pl-2 pr-2.5 text-left transition-colors duration-150 hover:bg-surface-2/40"
                >
                  <ChevronRight
                    className={`h-3.5 w-3.5 shrink-0 text-sand-dim transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
                    aria-hidden="true"
                  />
                  <span
                    aria-hidden="true"
                    style={{ background: g.color || '#b7891e' }}
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-[0.08em] text-parchment">
                    {g.name}
                  </span>
                  <span className="shrink-0 font-mono text-[9px] text-sand-dim">{g.files.length}</span>
                </button>
              )}
              {open && groupFiles.length > 0 && (
                <ul className="ml-3 space-y-0 border-l border-hairline-s pl-1.5">
                  {groupFiles.map((n, i) => fileRow(n, i, false))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>

      {/* ungrouped */}
      {groups.length > 0 && ungrouped.length > 0 && (
        <p className="mt-3 px-2 font-mono text-[9px] uppercase tracking-[0.2em] text-sand-dim">
          Ungrouped
        </p>
      )}
      {/* empty-state message: while loading show it only before any groups load;
          once loaded show it whenever NOTHING is visible — for a search that
          means "no match" even if groups exist (they all filter out to nothing),
          for an empty query only when there are truly no files and no groups */}
      {(!loaded ? groups.length === 0 : totalVisible === 0 && (q !== '' || groups.length === 0)) ? (
        <p className="mt-3 px-2 py-2 font-display text-[13px] italic text-sand-dim">
          {loaded ? (q !== '' ? 'No canvas files match.' : 'No canvas files yet.') : 'Loading…'}
        </p>
      ) : (
        <ul className="mt-1 space-y-0 border-t border-hairline-s">
          {/* drag-reorder only in the unfiltered view — during a search the list
              is relevance-sorted, so a drop would persist a misleading order */}
          {ungrouped.map((f, i) => fileRow(f.name, i, q === ''))}
        </ul>
      )}

      {/* — file context menu — */}
      {fileMenu !== null && (
        <div
          ref={fileMenuRef}
          role="menu"
          className="fixed z-50 min-w-[12rem] border border-hairline bg-surface py-1 shadow-lg shadow-black/40"
          style={{ left: fileMenu.x, top: fileMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onOpenCanvas(fileMenu.name)
              setFileMenu(null)
            }}
            className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
          >
            <Pencil className="h-3 w-3" aria-hidden="true" />
            Open
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              renameFileGuardRef.current = false
              setRenameFileValue(fileMenu.name)
              setRenamingFile(fileMenu.name)
              setFileMenu(null)
            }}
            className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
          >
            <PenLine className="h-3 w-3" aria-hidden="true" />
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void api.setCanvasActive(fileMenu.name).catch(() => {})
              setFileMenu(null)
            }}
            className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
          >
            <Check className="h-3 w-3" aria-hidden="true" />
            Set MCP active
          </button>
          <div
            className="relative"
            onPointerEnter={() => setMoveOpen(true)}
            onPointerLeave={() => setMoveOpen(false)}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => setMoveOpen((o) => !o)}
              className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
            >
              <FolderInput className="h-3 w-3" aria-hidden="true" />
              <span className="flex-1">Move to group</span>
              <ChevronRight className="h-3 w-3" aria-hidden="true" />
            </button>
            {moveOpen && (
              <div className="absolute left-full top-0 ml-px min-w-[10rem] border border-hairline bg-surface py-1 shadow-lg shadow-black/40">
                {groups.length === 0 && (
                  <div className="px-3 py-2 font-display text-[12px] italic text-sand-dim">
                    No groups yet
                  </div>
                )}
                {groups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => void moveToGroup(fileMenu.name, g.id)}
                    className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
                  >
                    <span
                      aria-hidden="true"
                      style={{ background: g.color || '#b7891e' }}
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                    />
                    <span className="truncate">{g.name}</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => void moveToGroup(fileMenu.name, null)}
                  className="flex w-full cursor-pointer items-center gap-2.5 border-t border-hairline-s px-3 py-2 text-left font-mono text-[10px] uppercase italic tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
                >
                  Ungrouped
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => void deleteFile(fileMenu.name)}
            className="flex w-full cursor-pointer items-center gap-2.5 border-t border-hairline-s px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-[#cf6b52]/12 hover:text-[#cf6b52]"
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            Delete
          </button>
        </div>
      )}

      {/* — group header context menu — */}
      {groupMenu !== null && (
        <div
          ref={groupMenuRef}
          role="menu"
          className="fixed z-50 min-w-[11rem] border border-hairline bg-surface py-1 shadow-lg shadow-black/40"
          style={{ left: groupMenu.x, top: groupMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const g = groups.find((x) => x.id === groupMenu.id)
              renameGuardRef.current = false
              setRenameValue(g?.name ?? '')
              setRenamingGroup(groupMenu.id)
              setGroupMenu(null)
            }}
            className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-surface-2/50 hover:text-brass"
          >
            <Pencil className="h-3 w-3" aria-hidden="true" />
            Rename group
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void deleteGroup(groupMenu.id)}
            className="flex w-full cursor-pointer items-center gap-2.5 border-t border-hairline-s px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:bg-[#cf6b52]/12 hover:text-[#cf6b52]"
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            Remove group
          </button>
        </div>
      )}
    </div>
  )
}

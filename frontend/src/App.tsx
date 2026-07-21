import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { MotionConfig } from 'framer-motion'
import { Ambience } from './components/Ambience'
import { Sidebar } from './components/Sidebar'
import { Workspace } from './components/Workspace'
import { NewProjectModal } from './components/NewProjectModal'
import { ChangeSessionModal } from './components/ChangeSessionModal'
import { ConfirmModal } from './components/ConfirmModal'
import { ProjectDetailsModal } from './components/ProjectDetailsModal'
import { EditProjectModal } from './components/EditProjectModal'
import { api } from './lib/api'
import type { ChatGroup, ComputerSession, GroupChat, GroupDirectory, Project } from './lib/api'
import { chatSocket } from './lib/chatSocket'

export type MainTab = 'chat' | 'terminals' | 'agents' | 'brain'
export type Theme = 'light' | 'dark'

/** an open workspace tab — one session (or a not-yet-created 'New' session).
    In multi mode the row is a fixed grid of `windowCount` SLOTS, each either a
    real tab or an EMPTY placeholder slot (empty: true). Empty slots are real,
    stable, focusable entries — closing a window turns it empty IN PLACE rather
    than shifting its neighbours. */
export interface WorkTab {
  key: string
  projectId: string
  /** null = a fresh, not-yet-created session */
  sessionId: string | null
  title: string
  /** true = an empty, focusable placeholder slot (no project/session bound) */
  empty?: boolean
}

/* Dark mode is the default; a stored preference (set by the theme toggle) wins.
   The index.html bootstrap already applied the .dark class before paint and
   migrated any old forced-'light' value, so this just mirrors that choice. */
function initialTheme(): Theme {
  try {
    return localStorage.getItem('cos-theme') === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/** which view selecting a session lands on — chat unless the user prefers the
    terminal (persisted under 'cos-default-view') */
export type DefaultView = 'chat' | 'terminals'
function initialDefaultView(): DefaultView {
  // default to Terminal unless the user has explicitly chosen Chat
  return localStorage.getItem('cos-default-view') === 'chat' ? 'chat' : 'terminals'
}

/** single pane vs multi pane — persisted under 'cos-pane-mode' */
export type PaneMode = 'single' | 'multi'
function initialPaneMode(): PaneMode {
  return localStorage.getItem('cos-pane-mode') === 'multi' ? 'multi' : 'single'
}

/** how many panes when multi (2–6) — persisted under 'cos-window-count' */
function initialWindowCount(): number {
  const raw = Number(localStorage.getItem('cos-window-count'))
  return Number.isFinite(raw) && raw >= 2 && raw <= 6 ? Math.floor(raw) : 2
}

/** a saved VIEW — a named snapshot of the whole multipane layout (how many
    windows + which chat sits in each slot) so you can switch between setups.
    Persisted on this computer in server/data/views.json (not the browser). */
/** how the canvas sits relative to the chat panes when a view has a canvas open */
export type CanvasLayout = 'full' | 'split'

export interface SavedView {
  id: string
  name: string
  paneMode: PaneMode
  windowCount: number
  tabs: WorkTab[]
  activeKey: string | null
  /** the Excalidraw canvas file this view opens (null = no canvas) */
  canvasFile: string | null
  /** 'full' = canvas only, 'split' = canvas beside the chat panes */
  canvasLayout: CanvasLayout
}
/* validate an untrusted array of views (from the server) into SavedView[] */
function coerceViews(parsed: unknown): SavedView[] {
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (v): v is SavedView =>
      v !== null &&
      typeof v === 'object' &&
      typeof v.id === 'string' &&
      typeof v.name === 'string' &&
      Array.isArray(v.tabs),
  )
}

/* the open-tab layout is saved so a multipane view (which chats, how many)
   survives a reload — persisted under 'cos-open-tabs' */
const OPEN_TABS_KEY = 'cos-open-tabs'
function loadSavedTabs(): { tabs: WorkTab[]; activeKey: string | null } {
  try {
    const raw = localStorage.getItem(OPEN_TABS_KEY)
    if (raw === null) return { tabs: [], activeKey: null }
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object') return { tabs: [], activeKey: null }
    const rawTabs = (parsed as { tabs?: unknown }).tabs
    if (!Array.isArray(rawTabs)) return { tabs: [], activeKey: null }
    const tabs: WorkTab[] = rawTabs
      .filter(
        (t): t is WorkTab =>
          t !== null &&
          typeof t === 'object' &&
          typeof (t as WorkTab).key === 'string' &&
          typeof (t as WorkTab).projectId === 'string' &&
          ((t as WorkTab).sessionId === null || typeof (t as WorkTab).sessionId === 'string') &&
          typeof (t as WorkTab).title === 'string',
      )
      /* normalise the empty flag to a strict boolean (it persists so the slot
         layout — which windows are blank — restores on reload) */
      .map((t) => ({ ...t, empty: (t as WorkTab).empty === true }))
    const activeKeyRaw = (parsed as { activeKey?: unknown }).activeKey
    const activeKey = typeof activeKeyRaw === 'string' ? activeKeyRaw : null
    return { tabs, activeKey }
  } catch {
    return { tabs: [], activeKey: null }
  }
}

let tabSeq = 0
function nextTabKey(): string {
  return `tab-${Date.now().toString(36)}-${tabSeq++}`
}

/** a fresh empty placeholder slot — a real, focusable, stable entry that renders
    no SessionPane and contributes nothing to the live markers / tab strip */
function makeEmptyTab(): WorkTab {
  return { key: nextTabKey(), projectId: '', sessionId: null, title: '', empty: true }
}

/** is this slot a real (non-empty) tab? */
function isReal(t: WorkTab): boolean {
  return t.empty !== true
}

function sessionTitle(project: Project | undefined, sessionId: string | null): string {
  if (sessionId === null) return 'New'
  const s = project?.sessions.find((x) => x.id === sessionId)
  if (s !== undefined && s.summary !== '') return s.summary
  return `Session ${sessionId.slice(0, 8)}`
}

/* deep-linkable routes: /session/<id> (resolves its project) and /project/<id> */
type Route =
  | { kind: 'session'; id: string }
  | { kind: 'project'; id: string }
  | { kind: 'home' }

function parseRoute(pathname: string): Route {
  const s = pathname.match(/^\/session\/([^/]+)\/?$/)
  if (s) return { kind: 'session', id: decodeURIComponent(s[1]) }
  const p = pathname.match(/^\/project\/([^/]+)\/?$/)
  if (p) return { kind: 'project', id: decodeURIComponent(p[1]) }
  return { kind: 'home' }
}

function routePath(projectId: string | null, sessionId: string | null): string {
  if (sessionId !== null) return `/session/${encodeURIComponent(sessionId)}`
  if (projectId !== null) return `/project/${encodeURIComponent(projectId)}`
  return '/'
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [projects, setProjects] = useState<Project[]>([])
  /* Projects (new model) = dir-less chat groups. Kept separate from the backend
     directory-projects above, which now only serve cwd→pty resolution. */
  const [groups, setGroups] = useState<ChatGroup[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  /* non-null = the project modal is open in EDIT mode for this id */
  const [editProjectId, setEditProjectId] = useState<string | null>(null)
  /* non-null = the Project (chat-group) details / edit modal is open for this id */
  const [detailsGroupId, setDetailsGroupId] = useState<string | null>(null)
  const [editGroupId, setEditGroupId] = useState<string | null>(null)
  /* non-null = the Excalidraw canvas is open in the main area, showing this file */
  const [canvasFile, setCanvasFile] = useState<string | null>(null)
  /* 'full' = canvas only, 'split' = canvas beside the chat panes */
  const [canvasLayout, setCanvasLayout] = useState<CanvasLayout>('split')
  /* canvas width (% of the split area) — draggable divider, persisted */
  const splitWrapRef = useRef<HTMLDivElement>(null)
  const [canvasSplitPct, setCanvasSplitPct] = useState<number>(() => {
    const v = Number(localStorage.getItem('cos-canvas-split'))
    return Number.isFinite(v) && v >= 20 && v <= 80 ? v : 50
  })
  /* true while dragging the divider — disables the iframe's pointer events so the
     cross-origin canvas can't swallow the drag */
  const [canvasResizing, setCanvasResizing] = useState(false)
  useEffect(() => {
    localStorage.setItem('cos-canvas-split', String(canvasSplitPct))
  }, [canvasSplitPct])
  /* push Christopher's theme into the embedded canvas iframe so its top bar +
     board match light/dark, and re-push when the iframe announces it's ready */
  const canvasIframeRef = useRef<HTMLIFrameElement>(null)
  const themeRef = useRef(theme)
  themeRef.current = theme
  const postCanvasTheme = useCallback(() => {
    try {
      canvasIframeRef.current?.contentWindow?.postMessage(
        { type: 'cos-theme', theme: themeRef.current },
        '*',
      )
    } catch {
      /* iframe not ready */
    }
  }, [])
  useEffect(() => {
    postCanvasTheme()
  }, [theme, canvasFile, postCanvasTheme])
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data && e.data.type === 'cos-canvas-ready') postCanvasTheme()
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [postCanvasTheme])
  const startCanvasResize = useCallback((e: ReactPointerEvent) => {
    e.preventDefault()
    const el = splitWrapRef.current
    const divider = e.currentTarget as HTMLElement
    if (el === null) return
    // capture the pointer on the divider so move/up keep firing even when the
    // cursor crosses the cross-origin canvas iframe (it can't steal events)
    try {
      divider.setPointerCapture(e.pointerId)
    } catch {
      /* not supported — the iframe pointer-events:none fallback still helps */
    }
    const onMove = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0) return
      const pct = ((rect.right - ev.clientX) / rect.width) * 100
      setCanvasSplitPct(Math.min(80, Math.max(20, pct)))
    }
    const end = () => {
      divider.removeEventListener('pointermove', onMove)
      divider.removeEventListener('pointerup', end)
      divider.removeEventListener('pointercancel', end)
      try {
        divider.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      document.body.style.userSelect = ''
      setCanvasResizing(false)
    }
    document.body.style.userSelect = 'none'
    setCanvasResizing(true)
    divider.addEventListener('pointermove', onMove)
    divider.addEventListener('pointerup', end)
    divider.addEventListener('pointercancel', end)
  }, [])
  /* non-null = the change-session-id modal is open for this chat. A registered
     session carries projectId; a Project group chat carries cwd (loose-open). */
  const [changeSessionFor, setChangeSessionFor] = useState<{
    sessionId: string
    projectId?: string
    cwd?: string
    groupId?: string
  } | null>(null)
  /* non-null = a destructive confirm dialog is pending */
  const [pendingDelete, setPendingDelete] = useState<
    { title: string; message: string; run: () => void } | null
  >(null)
  /* the view selecting a session lands on — persisted preference */
  const [defaultView, setDefaultView] = useState<DefaultView>(initialDefaultView)
  /* explicit pane-view request (right-click → "Chat view"): the nonce bumps so a
     repeat fires; SessionPane switches the pane bound to that session id. */
  const viewReqSeq = useRef(0)
  const [viewRequest, setViewRequest] = useState<{
    sessionId: string
    view: DefaultView
    nonce: number
  } | null>(null)
  const requestPaneView = useCallback((sessionId: string, view: DefaultView) => {
    viewReqSeq.current += 1
    setViewRequest({ sessionId, view, nonce: viewReqSeq.current })
  }, [])
  /* the index cabinet can fold away to hand the floor more room */
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem('cos-sidebar-collapsed') === '1',
  )
  useEffect(() => {
    localStorage.setItem('cos-sidebar-collapsed', sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])

  /* — open tabs + the active one + single|split floor — */
  const [openTabs, setOpenTabs] = useState<WorkTab[]>([])
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null)
  const [paneMode, setPaneMode] = useState<PaneMode>(initialPaneMode)
  const [windowCount, setWindowCount] = useState<number>(initialWindowCount)
  /* saved layouts (named views) — persisted on this computer (server/data/
     views.json), not the browser, so they survive a cache clear / browser swap
     and live alongside the projects. */
  const [views, setViews] = useState<SavedView[]>([])
  const viewsLoadedRef = useRef(false)
  useEffect(() => {
    let cancelled = false
    api
      .getViews()
      .then((raw) => {
        if (!cancelled) setViews(coerceViews(raw))
      })
      .catch(() => {
        /* server unreachable — keep the empty set; saving stays disabled until
           a load succeeds so we never clobber stored views with nothing */
      })
      .finally(() => {
        if (!cancelled) viewsLoadedRef.current = true
      })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    /* only persist AFTER the initial load resolved, so the empty starting state
       can't overwrite the views stored on disk */
    if (!viewsLoadedRef.current) return
    void api.saveViews(views).catch(() => {
      /* best effort — a failed save shouldn't break the UI */
    })
  }, [views])

  /* live shell session ids, merged across every pane: each pane reports its
     connected ids keyed by tab; we flatten + dedupe for the sidebar and the
     tab dots */
  const [paneActiveSessions, setPaneActiveSessions] = useState<Record<string, string[]>>({})
  /* the authoritative live set pushed by the server (sessions with a live pty),
     independent of which windows are open — so a session's green dot survives
     switching/closing the pane that showed it, and clears only when its pty
     actually exits or is reaped. */
  const [serverLiveSessions, setServerLiveSessions] = useState<string[]>([])
  /* green-dot source: the union of the server's live ptys and this client's
     currently-connected panes (the latter covers the instant before the first
     server push lands). serverLiveSessions is authoritative and a superset in
     the steady state, but the union is harmless and avoids any first-paint gap. */
  const activeSessions = useMemo(() => {
    const set = new Set<string>()
    for (const ids of Object.values(paneActiveSessions)) {
      for (const id of ids) set.add(id)
    }
    for (const id of serverLiveSessions) set.add(id)
    return [...set]
  }, [paneActiveSessions, serverLiveSessions])

  /* Sessions whose shell pty is stale because a CHAT turn appended messages the
     running (separate) claude process hasn't loaded. The shell re-resumes the
     next time it's viewed. bumping shellRefresh drives it. */
  const staleShellRef = useRef<Set<string>>(new Set())
  const [shellRefresh, setShellRefresh] = useState(0)

  /* global "refresh all chats": reconnect every mounted pane's shell + re-read
     every chat log, and force the shared chat socket to reconnect now. Recovers
     chat UIs that reset after the browser suspended/moved a backgrounded tab —
     without losing app state to a full page reload. */
  const [reconnectAllSignal, setReconnectAllSignal] = useState(0)
  const handleRefreshAllChats = useCallback(() => {
    setReconnectAllSignal((n) => n + 1)
    chatSocket.reconnect()
  }, [])

  /* the active tab's session/project drive routing + the chatSocket handler.
     An EMPTY active slot binds neither a project nor a session — it falls back to
     the sidebar-selected project for routing. */
  const activeTab = openTabs.find((t) => t.key === activeTabKey) ?? null
  const activeTabReal = activeTab !== null && isReal(activeTab)
  const activeSessionId = activeTabReal ? (activeTab as WorkTab).sessionId : null
  const activeProjectId = activeTabReal ? (activeTab as WorkTab).projectId : null
  const activeSessionIdRef = useRef<string | null>(activeSessionId)
  activeSessionIdRef.current = activeSessionId
  /* the active tab key, mirrored for the stable chatSocket handler */
  const activeTabKeyRef = useRef<string | null>(activeTabKey)
  activeTabKeyRef.current = activeTabKey
  /* guards the state->URL sync until the initial deep link has been applied */
  const didInitRouteRef = useRef(false)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('cos-theme', theme)
  }, [theme])

  useEffect(() => {
    localStorage.setItem('cos-default-view', defaultView)
  }, [defaultView])

  useEffect(() => {
    localStorage.setItem('cos-pane-mode', paneMode)
  }, [paneMode])

  useEffect(() => {
    localStorage.setItem('cos-window-count', String(windowCount))
  }, [windowCount])

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await api.getProjects())
    } catch {
      /* server offline — keep the last known catalog */
    }
  }, [])

  /* Projects (chat groups) load once on mount and update locally on edits */
  useEffect(() => {
    let cancelled = false
    api
      .getGroups()
      .then((g) => {
        if (!cancelled) setGroups(g)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const handleNewGroup = async (chat?: { sessionId: string; cwd: string }) => {
    let group: ChatGroup
    try {
      group = await api.createGroup('New project')
    } catch {
      return
    }
    // show the group immediately, even if the optional seed-add below fails
    setGroups((prev) => [...prev, group])
    if (chat !== undefined) {
      try {
        const seeded = await api.addChatToGroup(group.id, chat.sessionId, chat.cwd)
        setGroups((prev) => prev.map((g) => (g.id === seeded.id ? seeded : g)))
      } catch {
        /* group still exists, just empty */
      }
    }
  }
  const handleRenameGroup = async (id: string, name: string) => {
    if (!name.trim()) return
    try {
      const group = await api.renameGroup(id, name.trim())
      setGroups((prev) => prev.map((g) => (g.id === id ? group : g)))
    } catch {
      /* ignore */
    }
  }
  /* drag-reorder projects (move up/down) — optimistic, then persist */
  const handleReorderGroups = (orderedIds: string[]) => {
    setGroups((prev) => {
      const byId = new Map(prev.map((g) => [g.id, g]))
      const next = orderedIds.map((id) => byId.get(id)).filter((g): g is ChatGroup => g !== undefined)
      for (const g of prev) if (!orderedIds.includes(g.id)) next.push(g)
      return next
    })
    void api.reorderGroups(orderedIds).catch(() => {})
  }
  const handleDeleteGroup = async (id: string) => {
    try {
      await api.deleteGroup(id)
      setGroups((prev) => prev.filter((g) => g.id !== id))
    } catch {
      /* ignore */
    }
  }
  /* edit a Project's metadata (name / reference directory / description / color) */
  const handleUpdateGroup = async (
    id: string,
    input: {
      name?: string
      directories?: GroupDirectory[]
      description?: string
      color?: string
    },
  ) => {
    const group = await api.updateGroup(id, input)
    setGroups((prev) => prev.map((g) => (g.id === id ? group : g)))
  }
  /* change a chat's working directory: move its .jsonl to the new dir, then (for a
     project chat) repoint the group member to the new cwd. Throws on failure so
     the modal can surface the message. */
  const handleMoveChat = async (
    groupId: string | null,
    sessionId: string,
    fromCwd: string,
    toCwd: string,
  ): Promise<void> => {
    await api.moveSession(sessionId, fromCwd, toCwd)
    if (groupId !== null) {
      await api.removeChatFromGroup(groupId, sessionId)
      const group = await api.addChatToGroup(groupId, sessionId, toCwd)
      setGroups((prev) => prev.map((g) => (g.id === group.id ? group : g)))
    }
  }
  /* drag-and-drop: move a chat from one project (group) to another */
  const handleMoveChatToProject = async (
    fromGroupId: string,
    toGroupId: string,
    sessionId: string,
    cwd: string,
  ) => {
    if (fromGroupId === toGroupId) return
    try {
      const src = await api.removeChatFromGroup(fromGroupId, sessionId)
      const dst = await api.addChatToGroup(toGroupId, sessionId, cwd)
      setGroups((prev) => prev.map((g) => (g.id === src.id ? src : g.id === dst.id ? dst : g)))
    } catch {
      /* ignore — refresh on next load */
    }
  }
  const handleAddChatToGroup = async (groupId: string, sessionId: string, cwd: string) => {
    try {
      const group = await api.addChatToGroup(groupId, sessionId, cwd)
      setGroups((prev) => prev.map((g) => (g.id === groupId ? group : g)))
    } catch {
      /* ignore */
    }
  }
  const handleRemoveChatFromGroup = async (groupId: string, sessionId: string) => {
    try {
      const group = await api.removeChatFromGroup(groupId, sessionId)
      setGroups((prev) => prev.map((g) => (g.id === groupId ? group : g)))
    } catch {
      /* ignore */
    }
  }

  /* open or focus a tab for (project, session); returns the key used */
  const openTab = useCallback(
    (projectId: string, sessionId: string | null, project?: Project) => {
      setOpenTabs((prev) => {
        const existing = prev.find(
          (t) => isReal(t) && t.projectId === projectId && t.sessionId === sessionId,
        )
        if (existing !== undefined) {
          setActiveTabKey(existing.key)
          return prev
        }
        const key = nextTabKey()
        const title = sessionTitle(project, sessionId)
        setActiveTabKey(key)
        return [...prev, { key, projectId, sessionId, title }]
      })
    },
    [],
  )

  /* initial load: restore the saved tab layout, then reconcile with the
     deep-link route, once the catalog is known */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      let ps: Project[] = []
      try {
        ps = await api.getProjects()
      } catch {
        /* server offline */
      }
      if (cancelled) return
      setProjects(ps)

      const validIds = new Set(ps.map((p) => p.id))
      /* restore saved tabs: keep empty placeholder slots (they have no project)
         AND real tabs whose project still exists — preserving slot positions so a
         multipane layout restores intact. The normalize effect reconciles the
         length to windowCount afterwards. */
      const saved = loadSavedTabs()
      let tabs: WorkTab[] = saved.tabs.filter((t) => t.empty === true || validIds.has(t.projectId))
      let activeKey = tabs.some((t) => t.key === saved.activeKey)
        ? saved.activeKey
        : (tabs.find((t) => isReal(t))?.key ?? tabs[0]?.key ?? null)

      /* reconcile the restored slot row to the persisted pane mode/count FIRST so
         the layout is valid (the [paneMode, windowCount] effect won't fire on load
         when those values are unchanged) — same rules as normalize: single strips
         empties; multi trims from the END / pads empties at the END, never
         reordering. The deep link is then applied INTO this sized row. */
      const restoredMode = initialPaneMode()
      const restoredCount = initialWindowCount()
      if (restoredMode === 'single') {
        tabs = tabs.filter((t) => isReal(t))
      } else if (tabs.length > restoredCount) {
        tabs = tabs.slice(0, restoredCount)
      } else if (tabs.length < restoredCount) {
        tabs = [
          ...tabs,
          ...Array.from({ length: restoredCount - tabs.length }, () => makeEmptyTab()),
        ]
      }
      if (!tabs.some((t) => t.key === activeKey)) {
        activeKey = tabs.find((t) => isReal(t))?.key ?? tabs[0]?.key ?? null
      }

      /* the deep link wins: ensure its session is in a focused slot. Fill the
         active slot IN PLACE if there is one (keeps the count); else append (only
         when single mode emptied the row). */
      let routeProjectId: string | null = null
      const route = parseRoute(window.location.pathname)
      if (route.kind === 'session') {
        const proj = ps.find((p) => p.sessions.some((s) => s.id === route.id))
        if (proj !== undefined) {
          routeProjectId = proj.id
          const existing = tabs.find(
            (t) => isReal(t) && t.projectId === proj.id && t.sessionId === route.id,
          )
          if (existing !== undefined) {
            activeKey = existing.key
          } else {
            const key = nextTabKey()
            const real: WorkTab = {
              key,
              projectId: proj.id,
              sessionId: route.id,
              title: sessionTitle(proj, route.id),
            }
            const activeIdx = tabs.findIndex((t) => t.key === activeKey)
            if (activeIdx !== -1) {
              tabs = tabs.map((t, i) => (i === activeIdx ? real : t))
            } else {
              tabs = [...tabs, real]
            }
            activeKey = key
          }
        }
      } else if (route.kind === 'project' && validIds.has(route.id)) {
        routeProjectId = route.id
      }

      /* seed the sidebar selection from the active slot if it's real, else from
         the first real slot — an empty active slot has no project of its own */
      const activeSlot = tabs.find((t) => t.key === activeKey)
      const activeTabProjectId =
        activeSlot !== undefined && isReal(activeSlot)
          ? activeSlot.projectId
          : (tabs.find((t) => isReal(t))?.projectId ?? null)
      setSelectedProjectId(routeProjectId ?? activeTabProjectId)
      setOpenTabs(tabs)
      setActiveTabKey(activeKey)
      didInitRouteRef.current = true
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /* save the tab layout (which chats + how many) so a multipane view restores
     on reload — guarded until the initial restore has run */
  useEffect(() => {
    if (!didInitRouteRef.current) return
    try {
      localStorage.setItem(
        OPEN_TABS_KEY,
        JSON.stringify({ tabs: openTabs, activeKey: activeTabKey }),
      )
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, [openTabs, activeTabKey])

  /* — normalize the slot row to the pane mode + window count, WITHOUT reordering
       existing entries (closing/switching must never move a neighbour) —
       • single: strip empty slots, keep reals in order; refocus a real if the
         active slot was empty.
       • multi: the row must be EXACTLY `windowCount` slots. Too many → trim from
         the END; too few → pad empty slots at the END. If more REAL tabs than
         windowCount when entering multi, keep the first windowCount (extra shells
         persist server-side). If the active slot is dropped, move focus to a
         surviving slot (prefer a real one). */
  useEffect(() => {
    if (!didInitRouteRef.current) return
    setOpenTabs((prev) => {
      let next: WorkTab[]
      if (paneMode === 'single') {
        next = prev.filter((t) => isReal(t))
        /* nothing to strip → leave the array (and focus) untouched */
        if (next.length === prev.length) return prev
      } else {
        const count = windowCount
        if (prev.length === count) return prev
        if (prev.length > count) {
          /* trim from the END — positions of surviving slots are preserved */
          next = prev.slice(0, count)
        } else {
          /* pad empty slots at the END */
          const pad = Array.from({ length: count - prev.length }, () => makeEmptyTab())
          next = [...prev, ...pad]
        }
      }
      /* if the active slot survived, keep it; else refocus a surviving slot
         (prefer a real one, fall back to the first slot) */
      setActiveTabKey((curr) => {
        if (curr !== null && next.some((t) => t.key === curr)) return curr
        const survivor = next.find((t) => isReal(t)) ?? next[0]
        if (survivor === undefined) return null
        if (isReal(survivor)) setSelectedProjectId(survivor.projectId)
        return survivor.key
      })
      /* drop live-marker contributions from any slot that no longer exists */
      const keep = new Set(next.map((t) => t.key))
      setPaneActiveSessions((prevPas) => {
        const rest: Record<string, string[]> = {}
        let changed = false
        for (const k of Object.keys(prevPas)) {
          if (keep.has(k)) rest[k] = prevPas[k]
          else changed = true
        }
        return changed ? rest : prevPas
      })
      return next
    })
  }, [paneMode, windowCount])

  /* state -> URL: reflect the ACTIVE TAB as /session/<id> or /project/<id> */
  useEffect(() => {
    if (!didInitRouteRef.current) return
    const path = routePath(activeProjectId ?? selectedProjectId, activeSessionId)
    if (window.location.pathname !== path) {
      window.history.pushState(null, '', path)
    }
  }, [activeProjectId, activeSessionId, selectedProjectId])

  /* URL -> state: back/forward navigation re-syncs the selection (opens/focuses
     a tab for the routed session/project) */
  useEffect(() => {
    const onPop = () => {
      const route = parseRoute(window.location.pathname)
      if (route.kind === 'session') {
        const proj = projects.find((p) => p.sessions.some((s) => s.id === route.id))
        if (proj !== undefined) {
          setSelectedProjectId(proj.id)
          /* route the session into a slot without breaking the multi-mode count:
             focus it if a real slot already holds it, else fill the active slot
             IN PLACE (multi) — fall back to openTab (single / no active slot) */
          setOpenTabs((prev) => {
            const existing = prev.find(
              (t) => isReal(t) && t.projectId === proj.id && t.sessionId === route.id,
            )
            if (existing !== undefined) {
              setActiveTabKey(existing.key)
              return prev
            }
            const activeIndex = prev.findIndex((t) => t.key === activeTabKeyRef.current)
            if (paneMode === 'multi' && activeIndex !== -1) {
              const newKey = nextTabKey()
              setActiveTabKey(newKey)
              return prev.map((t, i) =>
                i === activeIndex
                  ? {
                      key: newKey,
                      projectId: proj.id,
                      sessionId: route.id,
                      title: sessionTitle(proj, route.id),
                    }
                  : t,
              )
            }
            const newKey = nextTabKey()
            setActiveTabKey(newKey)
            return [
              ...prev,
              {
                key: newKey,
                projectId: proj.id,
                sessionId: route.id,
                title: sessionTitle(proj, route.id),
              },
            ]
          })
        }
      } else if (route.kind === 'project') {
        setSelectedProjectId(projects.some((p) => p.id === route.id) ? route.id : null)
      } else {
        setSelectedProjectId(null)
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [projects, paneMode])

  /* — chat socket pushes: session catalog updates + the id of a session born
       from a fresh chat — */
  useEffect(() => {
    return chatSocket.subscribe((ev) => {
      if (ev.type === 'live-sessions') {
        /* authoritative live-pty set from the server — drives the green dots so
           they persist across pane switches and clear only on real exit/reap */
        setServerLiveSessions(ev.ids)
      } else if (ev.type === 'sessions-updated') {
        void refreshProjects()
      } else if (ev.type === 'session-created') {
        /* bind the fresh session onto the active 'New' tab so "Open in Shell"
           resumes it (only if the active tab hasn't already minted an id) */
        setOpenTabs((prev) =>
          prev.map((t) =>
            t.key === activeTabKeyRef.current && isReal(t) && t.sessionId === null
              ? { ...t, sessionId: ev.sessionId }
              : t,
          ),
        )
        /* pull the just-created session into the catalog so its tab shows the real
           summary instead of the "Session <id>" fallback — don't wait on a
           possibly-missed/raced sessions-updated push. Two beats cover a slow
           JSONL flush; refreshProjects is idempotent + deduped. */
        window.setTimeout(() => void refreshProjects(), 500)
        window.setTimeout(() => void refreshProjects(), 2000)
      } else if (ev.type === 'done') {
        /* a chat turn finished — the session's JSONL is now written/flushed, so
           refetch the catalog to resolve its real name (the earlier
           session-created refetch can fire before the file lands, leaving the tab
           on the "Session <id>" fallback until a manual reload). */
        void refreshProjects()
        /* a chat turn finished — its shell (if open) is now stale and must
           re-resume to show the new messages */
        if (ev.sessionId) {
          staleShellRef.current.add(ev.sessionId)
          /* if the active tab is already watching this session's shell, refresh
             now — the on-view effect won't re-fire while it stays focused */
          if (ev.sessionId === activeSessionIdRef.current) {
            staleShellRef.current.delete(ev.sessionId)
            setShellRefresh((n) => n + 1)
          }
        }
      }
    })
  }, [refreshProjects])

  /* refresh-on-view: focusing a tab whose session a chat turn touched
     re-resumes its shell (the focused pane's terminal honors the bump) */
  useEffect(() => {
    if (activeSessionId !== null && staleShellRef.current.has(activeSessionId)) {
      staleShellRef.current.delete(activeSessionId)
      setShellRefresh((n) => n + 1)
    }
  }, [activeTabKey, activeSessionId])

  const handleSelectProject = (id: string) => {
    setSelectedProjectId(id)
  }

  /* sidebar session click — slot-centric:
     - if a REAL window already holds (selectedProject, id) → just focus it
       (highlight that window — never duplicate the conversation)
     - else fill the ACTIVE slot IN PLACE (works whether it was empty or filled);
       its neighbours keep their positions
     - if there is no active slot / no tabs yet → open the first one */
  const selectSessionWithProject = (proj: Project, sessionId: string) => {
    // in split view the chat lives BESIDE the canvas — keep the canvas open and
    // just fill the focused pane; in full view, opening a chat closes the canvas
    if (canvasLayout !== 'split') setCanvasFile(null)
    const projectId = proj.id
    // a chat carries its OWN project — never the sidebar's last-selected one, or a
    // session from project B would launch claude in project A's cwd (not found).
    setSelectedProjectId(projectId)

    const existing = openTabs.find(
      (t) => isReal(t) && t.projectId === projectId && t.sessionId === sessionId,
    )
    if (existing !== undefined) {
      setActiveTabKey(existing.key)
      return
    }

    /* no active slot / no tabs → open the first window */
    const activeIndex = openTabs.findIndex((t) => t.key === activeTabKey)
    if (activeTabKey === null || openTabs.length === 0 || activeIndex === -1) {
      openTab(projectId, sessionId, proj)
      return
    }

    /* fill the focused slot — replace it with a fresh real tab (new key) so the
       pane cleanly remounts onto the new session AND project cwd; positions stay
       put. The old shell (if any) persists server-side. */
    const replacedKey = openTabs[activeIndex].key
    const newKey = nextTabKey()
    setOpenTabs((prev) =>
      prev.map((t, i) =>
        i === activeIndex
          ? {
              key: newKey,
              projectId,
              sessionId,
              title: sessionTitle(proj, sessionId),
            }
          : t,
      ),
    )
    setActiveTabKey(newKey)
    setPaneActiveSessions((prev) => {
      if (!(replacedKey in prev)) return prev
      const rest: Record<string, string[]> = {}
      for (const k of Object.keys(prev)) {
        if (k !== replacedKey) rest[k] = prev[k]
      }
      return rest
    })
  }

  const handleSelectSession = (projectId: string, sessionId: string) => {
    const proj = projects.find((p) => p.id === projectId)
    if (proj === undefined) return
    selectSessionWithProject(proj, sessionId)
  }

  /* open a session from the global "This computer" list. Registered owner →
     open directly; otherwise mint/find a hidden "loose" project for its EXACT
     cwd so claude resumes in the right folder, then open that. */
  const handleOpenComputerSession = async (s: ComputerSession, view?: DefaultView) => {
    if (s.projectId !== null) {
      const proj = projects.find((p) => p.id === s.projectId)
      if (proj !== undefined) {
        selectSessionWithProject(proj, s.sessionId)
        if (view) requestPaneView(s.sessionId, view)
        return
      }
    }
    if (!s.cwd) return // can't resume without a known working directory
    try {
      const project = await api.openLooseSession(s.cwd)
      setProjects((prev) =>
        prev.some((p) => p.id === project.id)
          ? prev.map((p) => (p.id === project.id ? project : p))
          : [...prev, project],
      )
      selectSessionWithProject(project, s.sessionId)
      if (view) requestPaneView(s.sessionId, view)
    } catch {
      /* directory may have been moved/deleted — nothing to open */
    }
  }

  /* "Add chat → New chat" in a project group: start a fresh claude session in
     the picked directory; once the session id is minted (handleSessionIdChange)
     the chat auto-joins the group. */
  // keyed by the EXACT tab opened — so only THAT freshly minted session joins the
  // group, never an unrelated 'New' tab that happens to share the loose project.
  // existingIds = the loose project's sessions BEFORE this chat, so the watcher
  // fallback (below) can spot the new one even when it mints in the terminal.
  const pendingGroupAddRef = useRef<{
    groupId: string
    tabKey: string
    cwd: string
    projectId: string
    existingIds: Set<string>
  } | null>(null)
  const handleNewChatInGroup = async (groupId: string, cwd: string): Promise<boolean> => {
    let project: Project
    try {
      project = await api.openLooseSession(cwd)
    } catch {
      return false // directory not found / bad path — the modal reports it
    }
    setProjects((prev) =>
      prev.some((p) => p.id === project.id)
        ? prev.map((p) => (p.id === project.id ? project : p))
        : [...prev, project],
    )
    const newKey = nextTabKey()
    const fresh: WorkTab = { key: newKey, projectId: project.id, sessionId: null, title: 'New' }
    pendingGroupAddRef.current = {
      groupId,
      tabKey: newKey,
      cwd,
      projectId: project.id,
      existingIds: new Set((project.sessions ?? []).map((s) => s.id)),
    }
    setSelectedProjectId(project.id)
    const activeIndex = openTabs.findIndex((t) => t.key === activeTabKey)
    if (paneMode === 'multi' && activeIndex !== -1) {
      const replacedKey = openTabs[activeIndex].key
      setOpenTabs((prev) => prev.map((t, i) => (i === activeIndex ? fresh : t)))
      setPaneActiveSessions((prev) => {
        if (!(replacedKey in prev)) return prev
        const rest: Record<string, string[]> = {}
        for (const k of Object.keys(prev)) {
          if (k !== replacedKey) rest[k] = prev[k]
        }
        return rest
      })
    } else {
      setOpenTabs((prev) => [...prev, fresh])
    }
    setActiveTabKey(newKey)
    return true
  }
  // stale-pending guard: if the awaited tab leaves the workspace (closed or
  // replaced in place) before its id mints, cancel the join
  useEffect(() => {
    const pending = pendingGroupAddRef.current
    if (pending !== null && !openTabs.some((t) => t.key === pending.tabKey)) {
      pendingGroupAddRef.current = null
    }
  }, [openTabs])

  /* fallback join: a "New chat in group" minted its id in the TERMINAL (so the
     chat-panel onSessionIdChange never fired). The sessions-updated watcher
     refreshes `projects`; the first session that's new in the loose project IS
     this chat — join it, and bind the id onto its tab so the pane resumes it. */
  useEffect(() => {
    const pending = pendingGroupAddRef.current
    if (pending === null) return
    const proj = projects.find((p) => p.id === pending.projectId)
    if (proj === undefined) return
    const minted = (proj.sessions ?? []).find((s) => !pending.existingIds.has(s.id))
    if (minted === undefined) return
    const { groupId, cwd, tabKey } = pending
    pendingGroupAddRef.current = null
    void api
      .addChatToGroup(groupId, minted.id, cwd)
      .then((group) => {
        setGroups((g) => g.map((x) => (x.id === group.id ? group : x)))
      })
      .catch((err) => {
        console.error('[claude-manager] fallback addChatToGroup failed:', err)
      })
    setOpenTabs((prev) =>
      prev.map((t) =>
        t.key === tabKey && isReal(t) && t.sessionId === null
          ? { ...t, sessionId: minted.id, title: sessionTitle(proj, minted.id) }
          : t,
      ),
    )
  }, [projects])

  /* open a chat that belongs to a Project group — it carries its OWN cwd, so
     loose-open by that cwd (ensureProjectForCwd dedupes to a registered project
     when the cwd matches one exactly). */
  const handleOpenGroupChat = async (chat: GroupChat, view?: DefaultView) => {
    if (!chat.cwd) return
    try {
      const project = await api.openLooseSession(chat.cwd)
      setProjects((prev) =>
        prev.some((p) => p.id === project.id)
          ? prev.map((p) => (p.id === project.id ? project : p))
          : [...prev, project],
      )
      selectSessionWithProject(project, chat.sessionId)
      if (view) requestPaneView(chat.sessionId, view)
    } catch {
      /* directory may have been moved/deleted — nothing to open */
    }
  }

  /* new chat — a fresh 'New' tab (sessionId null) for the selected project.
     single: append + focus (the strip switches among reals).
     multi: fill the ACTIVE slot IN PLACE (empty or filled) so positions hold;
     if there's no active slot, append (the normalize effect keeps the count). */
  const handleNewSession = () => {
    if (canvasLayout !== 'split') setCanvasFile(null)
    if (selectedProjectId === null) return
    const newKey = nextTabKey()
    const fresh: WorkTab = {
      key: newKey,
      projectId: selectedProjectId,
      sessionId: null,
      title: 'New',
    }
    const activeIndex = openTabs.findIndex((t) => t.key === activeTabKey)
    if (paneMode === 'multi' && activeIndex !== -1) {
      const replacedKey = openTabs[activeIndex].key
      setOpenTabs((prev) => prev.map((t, i) => (i === activeIndex ? fresh : t)))
      setPaneActiveSessions((prev) => {
        if (!(replacedKey in prev)) return prev
        const rest: Record<string, string[]> = {}
        for (const k of Object.keys(prev)) {
          if (k !== replacedKey) rest[k] = prev[k]
        }
        return rest
      })
    } else {
      setOpenTabs((prev) => [...prev, fresh])
    }
    setActiveTabKey(newKey)
  }

  /* focus a slot — empty slots are focusable too. Focusing a REAL slot syncs the
     sidebar to its project; focusing an EMPTY slot leaves the sidebar selection
     intact so the next session click fills THIS window. */
  const handleSelectTab = useCallback((key: string) => {
    // focusing a chat pane never closes the canvas (it just glows the pane)
    setActiveTabKey(key)
    setOpenTabs((prev) => {
      const t = prev.find((x) => x.key === key)
      if (t !== undefined && isReal(t)) setSelectedProjectId(t.projectId)
      return prev
    })
  }, [])

  /* rename a project / give a session a custom title, then refetch the catalog */
  const handleRenameProject = useCallback(
    async (id: string, name: string) => {
      try {
        await api.renameProject(id, name)
        await refreshProjects()
      } catch {
        /* keep the old name on failure */
      }
    },
    [refreshProjects],
  )
  const handleRenameSession = useCallback(
    async (projectId: string, sessionId: string, title: string) => {
      try {
        await api.renameSession(projectId, sessionId, title)
        await refreshProjects()
      } catch {
        /* keep the old title on failure */
      }
    },
    [refreshProjects],
  )
  const handleTerminateSession = useCallback(
    async (projectId: string, sessionId: string) => {
      try {
        await api.terminateSession(projectId, sessionId)
      } catch {
        /* the shell may already be gone */
      }
    },
    [],
  )
  /* terminate a chat's live shell by its cwd (Project / Directory chats) */
  const handleTerminateChat = useCallback(async (cwd: string, sessionId: string) => {
    try {
      await api.terminateSessionByCwd(cwd, sessionId)
    } catch {
      /* the shell may already be gone */
    }
  }, [])
  const handleRevealDir = useCallback(async (projectId: string) => {
    try {
      await api.revealProjectDir(projectId)
    } catch {
      /* file manager may be unavailable */
    }
  }, [])

  /* — saved views (named multipane layouts) — */
  const handleSaveView = () => {
    setViews((prev) => [
      ...prev,
      {
        id: `view-${Date.now().toString(36)}-${prev.length}`,
        name: `View ${prev.length + 1}`,
        paneMode,
        windowCount,
        tabs: openTabs,
        activeKey: activeTabKey,
        canvasFile,
        canvasLayout,
      },
    ])
  }
  const handleLoadView = (id: string) => {
    const view = views.find((v) => v.id === id)
    if (view === undefined) return
    setPaneMode(view.paneMode)
    setWindowCount(view.windowCount)
    setOpenTabs(view.tabs)
    setActiveTabKey(view.activeKey)
    // restore the canvas paired with this view (null clears it)
    setCanvasFile(view.canvasFile ?? null)
    setCanvasLayout(view.canvasLayout === 'split' ? 'split' : 'full')
  }
  const handleUpdateView = (id: string) => {
    setViews((prev) =>
      prev.map((v) =>
        v.id === id
          ? { ...v, paneMode, windowCount, tabs: openTabs, activeKey: activeTabKey, canvasFile, canvasLayout }
          : v,
      ),
    )
  }
  const handleDeleteView = (id: string) => setViews((prev) => prev.filter((v) => v.id !== id))
  const handleRenameView = (id: string, name: string) => {
    const n = name.trim()
    if (n === '') return
    setViews((prev) => prev.map((v) => (v.id === id ? { ...v, name: n } : v)))
  }

  /* drag-to-rearrange: SWAP the two slots' positions (a window dropped onto an
     empty slot just moves there; two windows trade places). Positions are the
     only thing that changes — keys, sessions, and live ptys are untouched. */
  const handleReorderTabs = useCallback((fromKey: string, toKey: string) => {
    if (fromKey === toKey) return
    setOpenTabs((prev) => {
      const fromIdx = prev.findIndex((t) => t.key === fromKey)
      const toIdx = prev.findIndex((t) => t.key === toKey)
      if (fromIdx === -1 || toIdx === -1) return prev
      const next = [...prev]
      const tmp = next[fromIdx]
      next[fromIdx] = next[toIdx]
      next[toIdx] = tmp
      return next
    })
  }, [])

  /* close a window:
     - MULTI: turn that slot EMPTY in place — its key changes to a fresh empty
       tab AT THE SAME INDEX, so neighbours never reflow and the count holds. If
       it was the active slot, keep focus on the now-empty slot.
     - SINGLE: remove (compact) the tab and focus a neighbour.
     Always drop the closed key's live-marker contribution. */
  const handleCloseTab = useCallback(
    (key: string) => {
      setOpenTabs((prev) => {
        const idx = prev.findIndex((t) => t.key === key)
        if (idx === -1) return prev

        /* closing the awaited "Add chat → New chat" tab cancels its pending join */
        if (pendingGroupAddRef.current?.tabKey === key) {
          pendingGroupAddRef.current = null
        }

        if (paneMode === 'multi') {
          /* replace in place with a fresh empty slot — no splice/shift */
          const empty = makeEmptyTab()
          const next = prev.map((t, i) => (i === idx ? empty : t))
          setActiveTabKey((curr) => (curr === key ? empty.key : curr))
          return next
        }

        /* single: compact, then focus the previous (or next) survivor */
        const next = prev.filter((t) => t.key !== key)
        setActiveTabKey((curr) => {
          if (curr !== key) return curr
          if (next.length === 0) return null
          const fallback = next[Math.min(idx, next.length - 1)]
          if (isReal(fallback)) setSelectedProjectId(fallback.projectId)
          return fallback.key
        })
        return next
      })
      /* drop the closed pane's live-session contribution */
      setPaneActiveSessions((prev) => {
        if (!(key in prev)) return prev
        const rest: Record<string, string[]> = {}
        for (const k of Object.keys(prev)) {
          if (k !== key) rest[k] = prev[k]
        }
        return rest
      })
    },
    [paneMode],
  )

  /* the ACTUAL deleters — run only after the confirm dialog is accepted */
  const doDeleteSession = useCallback(
    async (projectId: string, sessionId: string) => {
      try {
        await api.deleteSession(projectId, sessionId)
      } catch {
        /* already gone */
      }
      openTabs
        .filter((t) => isReal(t) && t.projectId === projectId && t.sessionId === sessionId)
        .forEach((t) => handleCloseTab(t.key))
      void refreshProjects()
    },
    [openTabs, handleCloseTab, refreshProjects],
  )
  const doDeleteProject = useCallback(
    async (projectId: string) => {
      try {
        await api.deleteProject(projectId)
      } catch {
        /* already gone */
      }
      openTabs
        .filter((t) => isReal(t) && t.projectId === projectId)
        .forEach((t) => handleCloseTab(t.key))
      setSelectedProjectId((cur) => (cur === projectId ? null : cur))
      void refreshProjects()
    },
    [openTabs, handleCloseTab, refreshProjects],
  )
  /* the menu items open a confirm first — destructive, so never one-click */
  const handleDeleteSession = (projectId: string, sessionId: string) => {
    const proj = projects.find((p) => p.id === projectId)
    const name = proj?.sessions.find((s) => s.id === sessionId)?.summary || 'this chat'
    setPendingDelete({
      title: 'Delete chat',
      message: `Delete “${name}”? Its transcript is hidden (recoverable from disk), and any window showing it is closed.`,
      run: () => void doDeleteSession(projectId, sessionId),
    })
  }
  const handleDeleteProject = (projectId: string) => {
    const name = projects.find((p) => p.id === projectId)?.name || 'this project'
    setPendingDelete({
      title: 'Delete project',
      message: `Remove “${name}” from Christopher OS? It is unregistered only — no files on disk are deleted, and you can re-add it.`,
      run: () => void doDeleteProject(projectId),
    })
  }

  /* a fresh session minted an id (from `done`) — update that tab's id + title
     so the next send + Open in Shell resume the REAL session */
  const handleSessionIdChange = useCallback((key: string, sid: string) => {
    /* "Add chat → New chat" in a project group: the minted id completes the
       membership. Done in the body (not the updater) so the updater stays pure. */
    const pending = pendingGroupAddRef.current
    if (pending !== null && pending.tabKey === key) {
      void api
        .addChatToGroup(pending.groupId, sid, pending.cwd)
        .then((group) => {
          pendingGroupAddRef.current = null
          setGroups((g) => g.map((x) => (x.id === group.id ? group : x)))
        })
        .catch((err) => {
          console.error('[claude-manager] addChatToGroup failed:', err)
        })
    }
    setOpenTabs((prev) =>
      prev.map((t) => {
        if (t.key !== key || !isReal(t)) return t
        const proj = projects.find((p) => p.id === t.projectId)
        const title = t.title === 'New' ? sessionTitle(proj, sid) : t.title
        return { ...t, sessionId: sid, title }
      }),
    )
  }, [projects])

  /* a pane reported its connected shell session ids — store keyed by tab so the
     merge picks up every open pane (only update on a real change) */
  const handleActiveSessionsChange = useCallback((key: string, ids: string[]) => {
    setPaneActiveSessions((prev) => {
      const before = prev[key] ?? []
      const a = [...before].sort().join(',')
      const b = [...ids].sort().join(',')
      if (a === b) return prev
      return { ...prev, [key]: ids }
    })
  }, [])

  /* refresh tab titles when the catalog learns a session's summary */
  useEffect(() => {
    setOpenTabs((prev) => {
      let changed = false
      const next = prev.map((t) => {
        if (t.sessionId === null) return t
        const proj = projects.find((p) => p.id === t.projectId)
        const fresh = sessionTitle(proj, t.sessionId)
        if (fresh !== t.title && fresh !== `Session ${t.sessionId.slice(0, 8)}`) {
          changed = true
          return { ...t, title: fresh }
        }
        return t
      })
      return changed ? next : prev
    })
  }, [projects])

  /* the project modal doubles as new + edit; a saved project updates the catalog
     (and, for a brand-new one, becomes the selection) */
  const handleProjectSaved = (project: Project) => {
    const wasEdit = editProjectId !== null
    setNewProjectOpen(false)
    setEditProjectId(null)
    setProjects((prev) => {
      // the create/update endpoints return the project record WITHOUT `sessions`;
      // carry the existing sessions (or []) so render code that maps p.sessions
      // never hits undefined before refreshProjects() lands the real list.
      const existing = prev.find((p) => p.id === project.id)
      const merged: Project = { ...project, sessions: project.sessions ?? existing?.sessions ?? [] }
      return [...prev.filter((p) => p.id !== project.id), merged]
    })
    if (!wasEdit) setSelectedProjectId(project.id)
    void refreshProjects()
  }

  return (
    <MotionConfig reducedMotion="user">
      <Ambience />
      <div className="relative z-[1] flex h-full">
        <Sidebar
          projects={projects}
          selectedProjectId={selectedProjectId}
          selectedSessionId={activeSessionId}
          activeSessions={activeSessions}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
          onSelectProject={handleSelectProject}
          onSelectSession={handleSelectSession}
          onOpenComputerSession={handleOpenComputerSession}
          groups={groups}
          onNewGroup={handleNewGroup}
          onRenameGroup={handleRenameGroup}
          onDeleteGroup={handleDeleteGroup}
          onShowGroup={(id) => setDetailsGroupId(id)}
          onEditGroup={(id) => setEditGroupId(id)}
          onMoveChat={handleMoveChat}
          onMoveChatToProject={handleMoveChatToProject}
          onReorderGroups={handleReorderGroups}
          onAddChatToGroup={handleAddChatToGroup}
          onRemoveChatFromGroup={handleRemoveChatFromGroup}
          onOpenGroupChat={handleOpenGroupChat}
          onChangeGroupChatSession={(groupId, cwd, sessionId) =>
            setChangeSessionFor({ groupId, cwd, sessionId })
          }
          onTerminateChat={handleTerminateChat}
          onNewChatInGroup={handleNewChatInGroup}
          onNewProject={() => setNewProjectOpen(true)}
          onNewSession={handleNewSession}
          onRenameProject={handleRenameProject}
          onRenameSession={handleRenameSession}
          onSessionsChanged={refreshProjects}
          onTerminateSession={handleTerminateSession}
          onEditProject={(id) => setEditProjectId(id)}
          onChangeSessionId={(projectId, sessionId) =>
            setChangeSessionFor({ projectId, sessionId })
          }
          onRevealDir={handleRevealDir}
          onDeleteSession={handleDeleteSession}
          onDeleteProject={handleDeleteProject}
          defaultView={defaultView}
          onDefaultViewChange={setDefaultView}
          canvasFile={canvasFile}
          onOpenCanvas={(name) => setCanvasFile(name)}
        />
        <div ref={splitWrapRef} className="relative flex min-w-0 flex-1">
        <Workspace
          openTabs={openTabs}
          activeTabKey={activeTabKey}
          paneMode={paneMode}
          windowCount={windowCount}
          views={views}
          onSaveView={handleSaveView}
          onLoadView={handleLoadView}
          onUpdateView={handleUpdateView}
          onDeleteView={handleDeleteView}
          onRenameView={handleRenameView}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          projects={projects}
          defaultView={defaultView}
          viewRequest={viewRequest}
          liveSessionIds={activeSessions}
          shellRefresh={shellRefresh}
          reconnectAllSignal={reconnectAllSignal}
          onRefreshAllChats={handleRefreshAllChats}
          onSelectTab={handleSelectTab}
          onCloseTab={handleCloseTab}
          onReorderTabs={handleReorderTabs}
          onSetPaneMode={setPaneMode}
          onSetWindowCount={setWindowCount}
          onSessionIdChange={handleSessionIdChange}
          onActiveSessionsChange={handleActiveSessionsChange}
          onNewProject={() => setNewProjectOpen(true)}
          canvasSplit={canvasFile !== null && canvasLayout === 'split'}
        />
        {canvasFile !== null && canvasLayout === 'split' && (
          <div
            onPointerDown={startCanvasResize}
            role="separator"
            aria-label="Drag to resize the canvas"
            title="Drag to resize"
            className={`w-2 shrink-0 cursor-col-resize transition-colors duration-150 hover:bg-brass ${
              canvasResizing ? 'bg-brass' : 'bg-hairline'
            }`}
          />
        )}
        {canvasFile !== null && (
          <div
            style={canvasLayout === 'split' ? { width: `${canvasSplitPct}%` } : undefined}
            className={
              canvasLayout === 'split'
                ? 'flex min-w-[280px] flex-col bg-surface'
                : 'absolute inset-0 z-30 flex flex-col bg-surface'
            }
          >
            <div className="flex items-center justify-between gap-3 border-b border-hairline bg-midnight-2 px-3 py-2">
              <div className="min-w-0">
                <span className="font-mono text-[9px] uppercase tracking-[0.24em] text-sand-dim">
                  Canvas
                </span>
                <div className="truncate font-mono text-[12px] text-parchment">{canvasFile}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setCanvasLayout((m) => (m === 'split' ? 'full' : 'split'))}
                  aria-label={canvasLayout === 'split' ? 'Canvas full screen' : 'Canvas side-by-side'}
                  title={canvasLayout === 'split' ? 'Full (canvas only)' : 'Split (canvas + chat)'}
                  className="mo-ticks flex h-8 cursor-pointer items-center gap-1.5 border border-hairline px-3 font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:border-brass hover:text-brass"
                >
                  {canvasLayout === 'split' ? 'Full' : 'Split'}
                </button>
                <button
                  type="button"
                  onClick={() => setCanvasFile(null)}
                  aria-label="Close canvas"
                  title="Close canvas"
                  className="mo-ticks flex h-8 cursor-pointer items-center gap-1.5 border border-hairline px-3 font-mono text-[10px] uppercase tracking-[0.18em] text-sand transition-colors duration-150 hover:border-brass hover:text-brass"
                >
                  Close ✕
                </button>
              </div>
            </div>
            <iframe
              key={canvasFile}
              ref={canvasIframeRef}
              onLoad={postCanvasTheme}
              src={`http://localhost:5111/${encodeURIComponent(canvasFile)}`}
              title="Excalidraw canvas"
              className={`min-h-0 w-full flex-1 border-0 bg-white ${canvasResizing ? 'pointer-events-none' : ''}`}
            />
          </div>
        )}
        </div>
      </div>
      <NewProjectModal
        open={newProjectOpen || editProjectId !== null}
        editProject={
          editProjectId !== null ? (projects.find((p) => p.id === editProjectId) ?? null) : null
        }
        onClose={() => {
          setNewProjectOpen(false)
          setEditProjectId(null)
        }}
        onCreated={handleProjectSaved}
      />
      <ChangeSessionModal
        open={changeSessionFor !== null}
        current={changeSessionFor?.sessionId ?? ''}
        onClose={() => setChangeSessionFor(null)}
        onSubmit={(id) => {
          if (changeSessionFor === null) return
          if (changeSessionFor.cwd !== undefined) {
            const { groupId, cwd, sessionId: oldId } = changeSessionFor
            // swap the member id in the group so the NEW session is the one that's
            // group-scoped (else the dead old id stays a member and the new one is
            // outside the shared context)
            if (groupId !== undefined && id !== oldId) {
              void (async () => {
                try {
                  await api.removeChatFromGroup(groupId, oldId)
                  const group = await api.addChatToGroup(groupId, id, cwd)
                  setGroups((prev) => prev.map((g) => (g.id === group.id ? group : g)))
                } catch {
                  /* leave membership as-is on failure */
                }
              })()
            }
            void handleOpenGroupChat({ sessionId: id, cwd })
          } else if (changeSessionFor.projectId !== undefined) {
            handleSelectSession(changeSessionFor.projectId, id)
          }
        }}
      />
      <ConfirmModal
        open={pendingDelete !== null}
        title={pendingDelete?.title ?? ''}
        message={pendingDelete?.message ?? ''}
        onConfirm={() => pendingDelete?.run()}
        onClose={() => setPendingDelete(null)}
      />
      <ProjectDetailsModal
        group={detailsGroupId !== null ? (groups.find((g) => g.id === detailsGroupId) ?? null) : null}
        onClose={() => setDetailsGroupId(null)}
        onEdit={() => {
          setEditGroupId(detailsGroupId)
          setDetailsGroupId(null)
        }}
      />
      <EditProjectModal
        group={editGroupId !== null ? (groups.find((g) => g.id === editGroupId) ?? null) : null}
        onClose={() => setEditGroupId(null)}
        onSave={handleUpdateGroup}
      />
    </MotionConfig>
  )
}

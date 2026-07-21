/**
 * api — typed REST client for the Christopher OS server (port 4000,
 * proxied through Vite at /api). Mirrors the locked API contract.
 */

export interface AppConfig {
  globalClaudeDir: string
  home: string
}

export interface SessionMeta {
  id: string
  summary: string
  lastActive: string
  messageCount: number
}

export interface Project {
  id: string
  name: string
  fileDir: string
  claudeDir: string
  isDefaultClaudeDir: boolean
  createdAt: string
  /** hidden "loose" project — opened from the global list, not shown under Projects */
  ephemeral: boolean
  /** sorted newest first by the server */
  sessions: SessionMeta[]
}

/** one Claude session JSONL anywhere on the machine (the "This computer" tab) */
export interface ComputerSession {
  sessionId: string
  summary: string
  lastActive: string
  messageCount: number
  /** the real working directory this session ran in (recovered from the JSONL) */
  cwd: string
  folder: string
  /** the registered project that owns this cwd, or null if the session is "loose" */
  projectId: string | null
  projectName: string | null
}

/** result of checking GitHub for a newer version of the app */
export interface UpdateCheck {
  ok: boolean
  /** present when ok: true */
  upToDate?: boolean
  behind?: number
  ahead?: number
  branch?: string
  localCommit?: string
  remoteCommit?: string
  latestSubject?: string
  remoteUrl?: string
  checkedAt?: string
  /** present when ok: false (not a git repo, offline, etc.) */
  error?: string
}

/** a chat reference inside a Project group — keeps its OWN claude cwd */
export interface GroupChat {
  sessionId: string
  cwd: string
}

/** a reference working directory on a project — NOT the Claude config dir.
    `commands` are zero or more terminal quick-launches runnable in this directory. */
export interface GroupDirectory {
  path: string
  commands: string[]
}

/** a listening TCP port in use, with its owning process (Settings → Ports) */
export interface PortInfo {
  port: number
  pid: number
  name: string
  address: string
  /** true when this is Christopher's own server process (stop is disabled) */
  isSelf: boolean
}

/** a "Project" in the new model: a dir-less named collection of chats, plus its
    own optional reference metadata (one or more working `directories` that are
    NOT the Claude config dir, a free-text `description`, and a `color` label) */
export interface ChatGroup {
  id: string
  name: string
  createdAt: string
  chats: GroupChat[]
  directories: GroupDirectory[]
  description: string
  color: string
}

/** one Excalidraw canvas file (from the canvas app's file API) */
export interface CanvasFile {
  name: string
  modified: string
  size: number
}

/** a canvas file group (collapsible colored section), mirroring the canvas app */
export interface CanvasGroup {
  id: string
  name: string
  color: string
  collapsed: boolean
  files: string[]
}

export interface ToolUse {
  name: string
  input: unknown
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  toolUse?: ToolUse[]
}

export interface CreateProjectInput {
  name: string
  fileDir: string
  claudeDir?: string
}

/** a directory Claude already has sessions for (under ~/.claude/projects) */
export interface DiscoveredProject {
  fileDir: string
  name: string
  sessionCount: number
  lastActive: string
  registered: boolean
}

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, init)
  } catch {
    throw new ApiError('The observatory is unreachable — is the server lit?', 0)
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON body — fall through to status handling */
  }

  if (!res.ok) {
    const message =
      body !== null &&
      typeof body === 'object' &&
      'error' in body &&
      typeof (body as { error: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Request failed (${res.status})`
    throw new ApiError(message, res.status)
  }

  return body as T
}

export const api = {
  getConfig(): Promise<AppConfig> {
    return request<AppConfig>('/api/config')
  },

  async getProjects(): Promise<Project[]> {
    const { projects } = await request<{ projects: Project[] }>('/api/projects')
    return projects
  },

  /** directories Claude has worked in (for the "pick existing project" picker) */
  async discoverProjects(): Promise<DiscoveredProject[]> {
    const { discovered } = await request<{ discovered: DiscoveredProject[] }>(
      '/api/discover-projects',
    )
    return discovered
  },

  /** list the Excalidraw canvas files (proxied from the canvas app on 4111);
      `running` is false when the canvas app isn't up yet */
  async getCanvasFiles(): Promise<{ running: boolean; files: CanvasFile[] }> {
    const res = await request<{ running?: boolean; files?: CanvasFile[] }>('/api/canvas/files')
    return { running: res.running === true, files: Array.isArray(res.files) ? res.files : [] }
  },

  /** launch the bundled Excalidraw canvas app (when it isn't running) */
  async startCanvas(): Promise<void> {
    await request('/api/canvas/start', { method: 'POST' })
  },

  /** create a new (empty) canvas file; returns the sanitized name the server used */
  async createCanvasFile(name: string): Promise<string> {
    const res = await request<{ name?: string }>(
      `/api/canvas/files/${encodeURIComponent(name)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ elements: [] }),
      },
    )
    return res.name || name
  },

  /** canvas file groups (collapsible sections), mirroring the canvas app sidebar */
  async getCanvasGroups(): Promise<CanvasGroup[]> {
    const { groups } = await request<{ groups?: CanvasGroup[] }>('/api/canvas/groups')
    return Array.isArray(groups) ? groups : []
  },
  /** search canvas files by their TYPED CONTENT (text elements, bound labels,
      frame names); returns the names of files whose content contains the query */
  async searchCanvasContent(q: string): Promise<string[]> {
    const res = await request<{ matches?: string[] }>(
      `/api/canvas/file-search?q=${encodeURIComponent(q)}`,
    )
    return Array.isArray(res.matches) ? res.matches : []
  },
  /** persist the global canvas file order after a drag-reorder */
  async reorderCanvasFiles(order: string[]): Promise<void> {
    await request('/api/canvas/files/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    })
  },
  /** rename a canvas file; carries its order position, group membership and the
      MCP active-file pointer forward. Returns the sanitized name the server used */
  async renameCanvasFile(oldName: string, newName: string): Promise<string> {
    const res = await request<{ name?: string }>(
      `/api/canvas/files/${encodeURIComponent(oldName)}/rename`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName }),
      },
    )
    return res.name || newName
  },
  /** delete a canvas file (the canvas server auto-backs it up first) */
  async deleteCanvasFile(name: string): Promise<void> {
    await request(`/api/canvas/files/${encodeURIComponent(name)}`, { method: 'DELETE' })
  },
  /** set the MCP-active canvas file (what the canvas MCP tools operate on) */
  async setCanvasActive(name: string): Promise<void> {
    await request('/api/canvas/active-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  },
  async createCanvasGroup(name: string, color?: string): Promise<void> {
    await request('/api/canvas/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(color ? { name, color } : { name }),
    })
  },
  async updateCanvasGroup(
    id: string,
    input: { name?: string; color?: string; collapsed?: boolean },
  ): Promise<void> {
    await request(`/api/canvas/groups/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  },
  async deleteCanvasGroup(id: string): Promise<void> {
    await request(`/api/canvas/groups/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  async moveCanvasFileToGroup(groupId: string, fileName: string): Promise<void> {
    await request(`/api/canvas/groups/${encodeURIComponent(groupId)}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName }),
    })
  },
  async removeCanvasFileFromGroup(groupId: string, fileName: string): Promise<void> {
    await request(
      `/api/canvas/groups/${encodeURIComponent(groupId)}/files/${encodeURIComponent(fileName)}`,
      { method: 'DELETE' },
    )
  },

  /** every Claude session jsonl on this machine, newest first ("This computer") */
  async getAllSessions(): Promise<ComputerSession[]> {
    const { sessions } = await request<{ sessions: ComputerSession[] }>('/api/all-sessions')
    return sessions
  },

  /** check GitHub for a newer version of the app (git fetch + compare HEADs) */
  async checkUpdates(): Promise<UpdateCheck> {
    return request<UpdateCheck>('/api/updates/check')
  },

  /** search transcript CONTENT (reads the jsonl). Pass sessionIds to restrict the
      scan (Projects tab members); omit to search every session on the machine. */
  async searchContent(
    query: string,
    sessionIds?: string[],
  ): Promise<{ sessionId: string; snippet: string }[]> {
    const params = new URLSearchParams({ q: query })
    if (sessionIds && sessionIds.length > 0) params.set('sessionIds', sessionIds.join(','))
    const { matches } = await request<{ matches: { sessionId: string; snippet: string }[] }>(
      `/api/search-content?${params.toString()}`,
    )
    return matches
  },

  /** ensure a hidden "loose" project for a session's cwd; returns it (with sessions) */
  async openLooseSession(cwd: string): Promise<Project> {
    const { project } = await request<{ project: Project }>('/api/sessions/open-loose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
    })
    return project
  },

  // — Projects (dir-less chat groups) —
  async getGroups(): Promise<ChatGroup[]> {
    const { groups } = await request<{ groups: ChatGroup[] }>('/api/groups')
    return groups
  },
  async createGroup(name: string): Promise<ChatGroup> {
    const { group } = await request<{ group: ChatGroup }>('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    return group
  },
  async renameGroup(id: string, name: string): Promise<ChatGroup> {
    const { group } = await request<{ group: ChatGroup }>(`/api/groups/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    return group
  },
  /** update a project's editable fields (name / directories / description / color) */
  async updateGroup(
    id: string,
    input: {
      name?: string
      directories?: GroupDirectory[]
      description?: string
      color?: string
    },
  ): Promise<ChatGroup> {
    const { group } = await request<{ group: ChatGroup }>(`/api/groups/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return group
  },
  deleteGroup(id: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/groups/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  /** reorder projects (drag up/down) */
  async reorderGroups(order: string[]): Promise<void> {
    await request('/api/groups/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    })
  },
  async addChatToGroup(id: string, sessionId: string, cwd: string): Promise<ChatGroup> {
    const { group } = await request<{ group: ChatGroup }>(
      `/api/groups/${encodeURIComponent(id)}/chats`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, cwd }),
      },
    )
    return group
  },
  async removeChatFromGroup(id: string, sessionId: string): Promise<ChatGroup> {
    const { group } = await request<{ group: ChatGroup }>(
      `/api/groups/${encodeURIComponent(id)}/chats/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    )
    return group
  },

  async createProject(input: CreateProjectInput): Promise<Project> {
    const { project } = await request<{ project: Project }>('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return project
  },

  /** unregisters only — never touches files on disk */
  deleteProject(id: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  async renameProject(id: string, name: string): Promise<Project> {
    const { project } = await request<{ project: Project }>(
      `/api/projects/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      },
    )
    return project
  },

  /** edit a project's name / file directory / Claude directory */
  async updateProject(
    id: string,
    input: { name?: string; fileDir?: string; claudeDir?: string },
  ): Promise<Project> {
    const { project } = await request<{ project: Project }>(
      `/api/projects/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    )
    return project
  },

  /** sets a custom session title (empty string clears it) */
  async renameSession(projectId: string, sessionId: string, title: string): Promise<string> {
    const res = await request<{ title: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      },
    )
    return res.title
  },

  /** rename a session by id alone (no project needed — used by Project chats) */
  async renameSessionById(sessionId: string, title: string): Promise<string> {
    const res = await request<{ title: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      },
    )
    return res.title
  },

  /** terminate a chat's live shell by cwd (Project/Directory chats, no project id) */
  async terminateSessionByCwd(cwd: string, sessionId: string): Promise<boolean> {
    const res = await request<{ killed: boolean }>('/api/sessions/terminate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, sessionId }),
    })
    return res.killed
  },

  /** terminate a session's live shell (kills the pty + claude process) */
  async terminateSession(projectId: string, sessionId: string): Promise<boolean> {
    const res = await request<{ killed: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/terminate`,
      { method: 'POST' },
    )
    return res.killed
  },

  /** delete a session (soft delete — kills its shell, hides the transcript) */
  deleteSession(projectId: string, sessionId: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    )
  },

  /** open this project's working directory in the OS file manager */
  async revealProjectDir(id: string): Promise<string> {
    const res = await request<{ path: string }>(
      `/api/projects/${encodeURIComponent(id)}/reveal-dir`,
      { method: 'POST' },
    )
    return res.path
  },

  /** run a project directory's saved command in a new terminal window at that dir */
  async runCommand(dir: string, command: string): Promise<void> {
    await request('/api/run-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir, command }),
    })
  },

  /** listening TCP ports in use, with the owning process (Settings → Ports) */
  async listPorts(): Promise<PortInfo[]> {
    const { ports } = await request<{ ports?: PortInfo[] }>('/api/ports')
    return Array.isArray(ports) ? ports : []
  },
  /** stop the process holding a port, by PID (refused for this app / system) */
  async killPort(pid: number): Promise<void> {
    await request('/api/ports/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid }),
    })
  },

  /** list sub-directories of a path (empty = drive list / root) — powers the
      in-app folder browser */
  async listDir(
    path: string,
  ): Promise<{ path: string; parent: string | null; entries: { name: string; path: string }[] }> {
    const params = new URLSearchParams({ path })
    return request(`/api/list-dir?${params.toString()}`)
  },

  /** open a native folder picker (Windows) and return the chosen path (null if
      cancelled) — legacy fallback */
  async pickDirectory(initial?: string): Promise<string | null> {
    const { path } = await request<{ path: string | null }>('/api/pick-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initial: initial ?? '' }),
    })
    return path
  },

  /** open a chat's transcript (.jsonl) in the OS file manager, selected */
  async revealSessionJsonl(cwd: string, sessionId: string): Promise<string> {
    const res = await request<{ path: string }>('/api/sessions/reveal-jsonl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, sessionId }),
    })
    return res.path
  },

  /** open an arbitrary folder (e.g. a project's reference directory) in the OS */
  async revealPath(path: string): Promise<string> {
    const res = await request<{ path: string }>('/api/reveal-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    return res.path
  },

  async getMessages(projectId: string, sessionId: string): Promise<ChatMessage[]> {
    const { messages } = await request<{ messages: ChatMessage[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
    )
    return messages
  },

  /** locate a session by id under a Claude projects dir (default global) + recover
      its cwd — powers "Add chat → By ID" */
  async resolveSession(
    sessionId: string,
    projectsDir?: string,
  ): Promise<{ sessionId: string; cwd: string; folder: string }> {
    const params = new URLSearchParams({ sessionId })
    if (projectsDir) params.set('projectsDir', projectsDir)
    const { session } = await request<{
      session: { sessionId: string; cwd: string; folder: string }
    }>(`/api/resolve-session?${params.toString()}`)
    return session
  },

  /** move a session transcript to another working directory (relocates the .jsonl
      so it resumes in the new dir) — powers per-chat "Change directory" */
  async moveSession(
    sessionId: string,
    fromCwd: string,
    toCwd: string,
  ): Promise<{ sessionId: string; cwd: string; folder: string }> {
    const { session } = await request<{
      session: { sessionId: string; cwd: string; folder: string }
    }>('/api/sessions/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, fromCwd, toCwd }),
    })
    return session
  },

  /** read a transcript by its cwd (no registered project) — the "View" quick-look */
  async getMessagesByCwd(cwd: string, sessionId: string): Promise<ChatMessage[]> {
    const params = new URLSearchParams({ cwd, sessionId })
    const { messages } = await request<{ messages: ChatMessage[] }>(
      `/api/session-messages?${params.toString()}`,
    )
    return messages
  },

  /** saved multipane layouts, persisted on this computer (server/data/views.json) */
  async getViews<T = unknown>(): Promise<T[]> {
    const { views } = await request<{ views: T[] }>('/api/views')
    return Array.isArray(views) ? views : []
  },

  /** replace the whole set of saved views; returns the stored (validated) set */
  async saveViews<T = unknown>(views: T[]): Promise<T[]> {
    const res = await request<{ views: T[] }>('/api/views', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ views }),
    })
    return res.views
  },
}

/** "3m ago" style relative timestamps for session plates */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffMs = Date.now() - then
  if (diffMs < 60_000) return 'just now'
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(then).toLocaleDateString()
}

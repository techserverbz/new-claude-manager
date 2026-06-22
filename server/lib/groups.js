// Chat groups — the NEW "Project" model: a named collection of chats that is
// NOT tied to any directory. A group's members can come from different Claude
// project directories; each member keeps its own cwd so it resumes in the right
// folder (via the loose-open / ensureProjectForCwd machinery). Directory-based
// projects still exist underneath purely as the cwd→pty mapping.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { normalizeFsPath, ValidationError, SESSION_ID_RE } from './projects.js'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = path.join(SERVER_ROOT, 'data')
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json')

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch {
    /* best effort */
  }
}

function hydrateChat(c) {
  if (!c || typeof c !== 'object') return null
  const sessionId = String(c.sessionId || '')
  if (!SESSION_ID_RE.test(sessionId)) return null
  return { sessionId, cwd: normalizeFsPath(c.cwd) }
}

// A project can reference MULTIPLE working directories (plain REFERENCE paths,
// NOT the Claude config dir). Each carries an optional `command` — reserved for
// the upcoming "run this terminal command in this directory" shortcut. Dirs may
// not exist on disk and are never required.
const COLOR_RE = /^#[0-9a-fA-F]{6}$/
function clampDescription(d) {
  const t = typeof d === 'string' ? d : ''
  return t.length > 4000 ? t.slice(0, 4000) : t
}
function clampColor(c) {
  return typeof c === 'string' && COLOR_RE.test(c) ? c : ''
}
function clampCommand(c) {
  const t = typeof c === 'string' ? c : ''
  return t.length > 2000 ? t.slice(0, 2000) : t
}
// commands[] for a directory; migrates the legacy single `command` string.
// Drops blanks, clamps each command's length, and caps the count.
function hydrateCommands(d) {
  const raw = Array.isArray(d.commands)
    ? d.commands
    : typeof d.command === 'string'
      ? [d.command]
      : []
  const out = []
  for (const c of raw) {
    if (typeof c !== 'string' || c.trim() === '') continue
    out.push(clampCommand(c))
    if (out.length >= 50) break
  }
  return out
}
// one directory entry: a path + its commands (string path, or {path, command|commands})
function hydrateDirectory(d) {
  if (typeof d === 'string') {
    const p = normalizeFsPath(d)
    return p ? { path: p, commands: [] } : null
  }
  if (!d || typeof d !== 'object') return null
  const p = normalizeFsPath(d.path)
  if (!p) return null
  return { path: p, commands: hydrateCommands(d) }
}
// directories[] from the record, migrating the legacy single `directory` string
function hydrateDirectories(record) {
  if (Array.isArray(record.directories)) {
    const seen = new Set()
    const out = []
    for (const entry of record.directories) {
      const dir = hydrateDirectory(entry)
      if (!dir) continue
      const key = dir.path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(dir)
    }
    return out
  }
  if (typeof record.directory === 'string' && record.directory.trim()) {
    const one = hydrateDirectory(record.directory)
    return one ? [one] : []
  }
  return []
}

function hydrate(record) {
  if (!record || typeof record !== 'object' || !record.id) return null
  const name =
    typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'Untitled project'
  const chats = Array.isArray(record.chats) ? record.chats.map(hydrateChat).filter(Boolean) : []
  return {
    id: String(record.id),
    name,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
    chats,
    // project metadata (all optional, default to empty)
    directories: hydrateDirectories(record),
    description: clampDescription(record.description),
    color: clampColor(record.color),
  }
}

function loadStore() {
  ensureDataDir()
  let raw
  try {
    raw = fs.readFileSync(GROUPS_FILE, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.groups) ? parsed.groups : []
    return list.map(hydrate).filter(Boolean)
  } catch (err) {
    const backup = `${GROUPS_FILE}.corrupt-${Date.now()}`
    try {
      fs.renameSync(GROUPS_FILE, backup)
      console.error(`groups.json is corrupt (${err?.message}); moved it to ${backup}`)
    } catch {
      /* ignore */
    }
    return []
  }
}

let groups = loadStore()

// Atomic write (temp + rename) so a crash mid-write never truncates the store.
function saveStore() {
  ensureDataDir()
  const tmp = `${GROUPS_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ groups }, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, GROUPS_FILE)
}

export function listGroups() {
  return groups.map((g) => ({
    ...g,
    chats: g.chats.map((c) => ({ ...c })),
    directories: g.directories.map((d) => ({ ...d })),
  }))
}

function getGroup(id) {
  return groups.find((g) => g.id === String(id))
}

function clampName(name) {
  const t = typeof name === 'string' ? name.trim() : ''
  if (!t) throw new ValidationError('name is required')
  return t.length > 120 ? t.slice(0, 120) : t
}

export function createGroup(name) {
  const group = {
    id: crypto.randomUUID(),
    name: clampName(name),
    createdAt: new Date().toISOString(),
    chats: [],
    directories: [],
    description: '',
    color: '',
  }
  groups.push(group)
  saveStore()
  return group
}

export function renameGroup(id, name) {
  const group = getGroup(id)
  if (!group) return undefined
  group.name = clampName(name)
  saveStore()
  return group
}

/** Update a project's editable fields. Only the keys present in `input` change;
 *  `directories` are reference paths (≠ the Claude config dir), each optional. */
export function updateGroup(id, input) {
  const group = getGroup(id)
  if (!group) return undefined
  const i = input && typeof input === 'object' ? input : {}
  if (i.name !== undefined) group.name = clampName(i.name)
  if (i.directories !== undefined) {
    group.directories = hydrateDirectories({ directories: i.directories })
  } else if (i.directory !== undefined) {
    // legacy single-directory update
    group.directories = hydrateDirectories({ directory: i.directory })
  }
  if (i.description !== undefined) group.description = clampDescription(i.description)
  if (i.color !== undefined) group.color = clampColor(i.color)
  saveStore()
  return group
}

/** Reorder the projects to match `orderedIds` (drag up/down). Any groups not in
 *  the list keep their relative order at the end. */
export function reorderGroups(orderedIds) {
  const ids = Array.isArray(orderedIds) ? orderedIds.map(String) : []
  const byId = new Map(groups.map((g) => [g.id, g]))
  const next = []
  for (const id of ids) {
    const g = byId.get(id)
    if (g && !next.includes(g)) next.push(g)
  }
  for (const g of groups) if (!next.includes(g)) next.push(g)
  groups = next
  saveStore()
  return listGroups()
}

export function deleteGroup(id) {
  const before = groups.length
  groups = groups.filter((g) => g.id !== String(id))
  if (groups.length === before) return false
  saveStore()
  return true
}

export function addChatToGroup(id, sessionId, cwd) {
  const group = getGroup(id)
  if (!group) return undefined
  const sid = String(sessionId)
  if (!SESSION_ID_RE.test(sid)) throw new ValidationError('invalid sessionId')
  const dir = normalizeFsPath(cwd)
  if (!dir) throw new ValidationError('cwd is required')
  // de-dup by sessionId+cwd (the same chat can't be added twice)
  if (!group.chats.some((c) => c.sessionId === sid && c.cwd === dir)) {
    group.chats.unshift({ sessionId: sid, cwd: dir }) // newest-added first
    saveStore()
  }
  return group
}

/** Every group that contains this session — used to scope cross-chat sharing
 *  to a project group (members may live in different Claude directories). */
export function findGroupsBySession(sessionId) {
  const sid = String(sessionId || '')
  if (!sid || sid === 'new') return []
  return groups.filter((g) => g.chats.some((c) => c.sessionId === sid))
}

export function removeChatFromGroup(id, sessionId) {
  const group = getGroup(id)
  if (!group) return undefined
  const sid = String(sessionId)
  const before = group.chats.length
  group.chats = group.chats.filter((c) => c.sessionId !== sid)
  if (group.chats.length !== before) saveStore()
  return group
}

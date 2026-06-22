// One chokidar watcher per registered project's session folder.
// On add/change/unlink of any *.jsonl (written by ANY process, including a
// shell-run claude), debounce 300ms and broadcast
// { type: 'sessions-updated', projectId } to all /ws chat clients.

import fs from 'node:fs'
import path from 'node:path'
import { watch } from 'chokidar'

const DEBOUNCE_MS = 300
const RETRY_MS = 10000 // session folder may not exist until the first claude run

export function createSessionWatchers({ sessionsDirFor, broadcast }) {
  /** @type {Map<string, {dir: string, watcher: import('chokidar').FSWatcher|null, retryTimer: NodeJS.Timeout|null, debounceTimer: NodeJS.Timeout|null, projectId: string, closed: boolean}>} */
  const entries = new Map()

  function fire(entry) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      broadcast({ type: 'sessions-updated', projectId: entry.projectId })
    }, DEBOUNCE_MS)
  }

  function attach(entry) {
    if (entry.closed || entry.watcher) return
    let watcher
    try {
      watcher = watch(entry.dir, {
        ignoreInitial: true,
        depth: 0,
        // Windows: native fs events miss appends to a session JSONL that an
        // interactive `claude --resume` holds OPEN and writes incrementally
        // (a separate `claude -p`, which closes the file on exit, is caught
        // fine — but the live shell is not). Poll the dir so every append is
        // detected regardless of open handles.
        usePolling: true,
        interval: 300,
        binaryInterval: 300,
      })
    } catch {
      scheduleRetry(entry)
      return
    }
    watcher.on('all', (_event, filePath) => {
      if (typeof filePath !== 'string' || !filePath.endsWith('.jsonl')) return
      // agent-*.jsonl subagent sidechains are excluded from the session list —
      // skip them here too so we don't broadcast no-op refreshes.
      if (path.basename(filePath).startsWith('agent-')) return
      fire(entry)
    })
    watcher.on('error', () => {
      /* transient fs errors — keep watching */
    })
    entry.watcher = watcher
  }

  function scheduleRetry(entry) {
    if (entry.closed || entry.retryTimer) return
    entry.retryTimer = setInterval(() => {
      if (entry.closed) return
      if (fs.existsSync(entry.dir)) {
        clearInterval(entry.retryTimer)
        entry.retryTimer = null
        attach(entry)
        // The folder appearing usually means a first session was just written.
        fire(entry)
      }
    }, RETRY_MS)
    if (typeof entry.retryTimer.unref === 'function') entry.retryTimer.unref()
  }

  function start(entry) {
    if (fs.existsSync(entry.dir)) attach(entry)
    else scheduleRetry(entry)
  }

  /** Watch (or re-watch) a project's session folder. Safe to call repeatedly. */
  function ensure(project) {
    const dir = sessionsDirFor(project)
    const existing = entries.get(project.id)
    if (existing) {
      if (existing.dir === dir) {
        // If we were waiting for the dir and it now exists, attach immediately.
        if (!existing.watcher && !existing.retryTimer) start(existing)
        else if (!existing.watcher && fs.existsSync(dir)) {
          if (existing.retryTimer) {
            clearInterval(existing.retryTimer)
            existing.retryTimer = null
          }
          attach(existing)
        }
        return
      }
      close(project.id)
    }
    const entry = {
      dir,
      watcher: null,
      retryTimer: null,
      debounceTimer: null,
      projectId: project.id,
      closed: false,
    }
    entries.set(project.id, entry)
    start(entry)
  }

  function close(projectId) {
    const entry = entries.get(projectId)
    if (!entry) return
    entry.closed = true
    if (entry.retryTimer) clearInterval(entry.retryTimer)
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    if (entry.watcher) {
      entry.watcher.close().catch(() => {})
    }
    entries.delete(projectId)
  }

  /** Reconcile watchers against the current registered project list. */
  function sync(projects) {
    const liveIds = new Set(projects.map((p) => p.id))
    for (const id of [...entries.keys()]) {
      if (!liveIds.has(id)) close(id)
    }
    for (const project of projects) ensure(project)
  }

  function closeAll() {
    for (const id of [...entries.keys()]) close(id)
  }

  return { ensure, close, sync, closeAll }
}

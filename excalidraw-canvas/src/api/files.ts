// Tiny client for our file API. Vite proxies /api -> :4000 in vite.config.ts.

export type FileEntry = { name: string; modified: string; size: number; sortOrder?: number }

export async function listFiles(): Promise<FileEntry[]> {
  const r = await fetch('/api/files')
  const d = await r.json()
  return d.files ?? []
}

export async function loadFile(name: string): Promise<{ exists: boolean; elements: any[]; appState: any }> {
  const r = await fetch(`/api/files/${encodeURIComponent(name)}`)
  return r.json()
}

export async function saveFile(name: string, elements: any[], appState: any = {}) {
  const r = await fetch(`/api/files/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ elements, appState }),
  })
  return r.json()
}

export async function deleteFile(name: string) {
  const r = await fetch(`/api/files/${encodeURIComponent(name)}`, { method: 'DELETE' })
  return r.json()
}

export async function getSettings(): Promise<{ canvasDir: string; backupDir: string; port: number }> {
  const r = await fetch('/api/settings')
  const d = await r.json()
  return d
}

export async function updateSettings(settings: { canvasDir?: string; backupDir?: string }) {
  const r = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
  return r.json()
}

export async function reorderFiles(order: string[]) {
  const r = await fetch('/api/files/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order }),
  })
  return r.json()
}

// Tell the API which file the browser is viewing (used by yctimlin compat shim
// so its global element ops target the right file).
export async function setActiveFile(name: string) {
  const r = await fetch('/api/active-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return r.json()
}

// ─── Groups ───────────────────────────────────────────────────────────────────

export interface Group {
  id: string
  name: string
  color: string
  collapsed: boolean
  files: string[]
}

export async function listGroups(): Promise<Group[]> {
  const r = await fetch('/api/groups')
  const d = await r.json()
  return d.groups ?? []
}

export async function createGroup(name: string, color?: string): Promise<Group> {
  const r = await fetch('/api/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color }),
  })
  const d = await r.json()
  return d.group
}

export async function updateGroup(id: string, updates: Partial<Group>): Promise<Group> {
  const r = await fetch(`/api/groups/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  const d = await r.json()
  return d.group
}

export async function deleteGroup(id: string) {
  await fetch(`/api/groups/${id}`, { method: 'DELETE' })
}

export async function addFileToGroup(groupId: string, fileName: string) {
  const r = await fetch(`/api/groups/${groupId}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName }),
  })
  return r.json()
}

export async function removeFileFromGroup(groupId: string, fileName: string) {
  await fetch(`/api/groups/${groupId}/files/${encodeURIComponent(fileName)}`, { method: 'DELETE' })
}

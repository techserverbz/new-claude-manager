import { useEffect, useState } from 'react'
import { listFiles, deleteFile, setActiveFile, reorderFiles, listGroups, createGroup, updateGroup, deleteGroup, addFileToGroup, removeFileFromGroup, type FileEntry, type Group } from '../api/files'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent, DragOverlay, type DragStartEvent } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

interface SidebarProps {
  currentFile: string
  onNavigate: (name: string) => void
  onRefresh?: (fn: () => void) => void
}

const GROUP_COLORS = ['#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#ec4899', '#06b6d4', '#84cc16']

function FileItem({ file, isActive, onNavigate, onDelete, onContext, isDragging }: {
  file: FileEntry
  isActive: boolean
  onNavigate: (name: string) => void
  onDelete: (name: string) => void
  onContext: (e: React.MouseEvent, name: string) => void
  isDragging?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: file.name })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    display: 'flex', alignItems: 'stretch', borderRadius: 6, marginBottom: 2,
    background: isActive ? '#1f1f1f' : 'transparent',
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = '#1f1f1f' }}
      onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      onContextMenu={(e) => { e.preventDefault(); onContext(e, file.name) }}
    >
      <div
        {...attributes}
        {...listeners}
        style={{
          display: 'flex', alignItems: 'center', padding: '0 4px 0 8px',
          cursor: 'grab', color: '#555', fontSize: 10, userSelect: 'none',
        }}
        title="Drag to reorder"
      >⠿</div>
      <button
        onClick={() => onNavigate(file.name)}
        style={{
          flex: 1, padding: '10px 8px 10px 4px', textAlign: 'left',
          background: 'transparent', border: 'none', cursor: 'pointer', overflow: 'hidden',
        }}
      >
        <div style={{ color: isActive ? '#fafafa' : '#bfbfbf', fontSize: 13, fontWeight: isActive ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: "'Space Grotesk', sans-serif" }}>
          {file.name}
        </div>
        <div style={{ color: '#737373', fontSize: 11, marginTop: 2, fontFamily: "'Inter', sans-serif" }}>
          {new Date(file.modified).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })}
        </div>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(file.name) }}
        title={`Delete ${file.name}`}
        style={{ background: 'transparent', border: 'none', color: '#737373', cursor: 'pointer', padding: '0 10px', fontSize: 14, opacity: 0.5, transition: 'color 0.15s, opacity 0.15s' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#dc2626'; (e.currentTarget as HTMLElement).style.opacity = '1' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#737373'; (e.currentTarget as HTMLElement).style.opacity = '0.5' }}
      >&times;</button>
    </div>
  )
}

function GroupSection({ group, files, currentFile, onNavigate, onDelete, onContext, onToggle, onRenameGroup, onDeleteGroup, onGroupContext }: {
  group: Group
  files: FileEntry[]
  currentFile: string
  onNavigate: (name: string) => void
  onDelete: (name: string) => void
  onContext: (e: React.MouseEvent, name: string) => void
  onToggle: () => void
  onRenameGroup: () => void
  onDeleteGroup: () => void
  onGroupContext: (e: React.MouseEvent) => void
}) {
  const groupFiles = files.filter(f => group.files.includes(f.name))

  return (
    <div style={{ marginBottom: 4 }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', padding: '6px 8px', cursor: 'pointer',
          borderRadius: 6, userSelect: 'none',
        }}
        onClick={onToggle}
        onContextMenu={(e) => {
          e.preventDefault()
          onGroupContext(e)
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1a1a1a' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      >
        <span style={{ color: '#737373', fontSize: 10, marginRight: 6, transition: 'transform 0.15s', transform: group.collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: group.color, marginRight: 8, flexShrink: 0 }} />
        <span style={{ color: '#d4d4d4', fontSize: 12, fontWeight: 600, fontFamily: "'Space Grotesk', sans-serif", flex: 1 }}>
          {group.name}
        </span>
        <span style={{ color: '#555', fontSize: 11 }}>{groupFiles.length}</span>
      </div>
      {!group.collapsed && (
        <div style={{ paddingLeft: 12 }}>
          {groupFiles.length === 0 && (
            <div style={{ color: '#555', fontSize: 11, padding: '4px 8px', fontStyle: 'italic' }}>Empty group</div>
          )}
          <SortableContext items={groupFiles.map(f => f.name)} strategy={verticalListSortingStrategy}>
            {groupFiles.map(f => (
              <FileItem
                key={f.name}
                file={f}
                isActive={f.name === currentFile}
                onNavigate={onNavigate}
                onDelete={onDelete}
                onContext={onContext}
              />
            ))}
          </SortableContext>
        </div>
      )}
    </div>
  )
}

export function Sidebar({ currentFile, onNavigate, onRefresh }: SidebarProps) {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; name: string } | null>(null)
  const [groupCtxMenu, setGroupCtxMenu] = useState<{ x: number; y: number; groupId: string; groupName: string } | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )

  const refresh = () => {
    listFiles().then(setFiles).catch(() => setFiles([]))
    listGroups().then(setGroups).catch(() => setGroups([]))
  }

  useEffect(() => {
    refresh()
    onRefresh?.(refresh)
  }, [])

  useEffect(() => {
    if (!ctxMenu && !groupCtxMenu) return
    const close = () => { setCtxMenu(null); setGroupCtxMenu(null) }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [ctxMenu, groupCtxMenu])

  const onCreate = () => {
    const name = prompt('New canvas name')?.trim()
    if (name) onNavigate(name)
  }

  const onCreateGroup = async () => {
    const name = prompt('New group name')?.trim()
    if (!name) return
    const colorIdx = groups.length % GROUP_COLORS.length
    await createGroup(name, GROUP_COLORS[colorIdx])
    refresh()
  }

  const onDelete = async (name: string) => {
    if (!confirm(`Delete "${name}"?`)) return
    await deleteFile(name)
    refresh()
    if (name === currentFile) onNavigate('')
  }

  const onSetMcpActive = async (name: string) => {
    await setActiveFile(name)
    setCtxMenu(null)
  }

  const onMoveToGroup = async (fileName: string, groupId: string | null) => {
    if (groupId) {
      await addFileToGroup(groupId, fileName)
    } else {
      const g = groups.find(g => g.files.includes(fileName))
      if (g) await removeFileFromGroup(g.id, fileName)
    }
    refresh()
    setCtxMenu(null)
  }

  const onToggleGroup = async (groupId: string) => {
    const g = groups.find(g => g.id === groupId)
    if (!g) return
    await updateGroup(groupId, { collapsed: !g.collapsed })
    setGroups(prev => prev.map(grp => grp.id === groupId ? { ...grp, collapsed: !grp.collapsed } : grp))
  }

  const onRenameGroup = async (groupId: string) => {
    const g = groups.find(g => g.id === groupId)
    if (!g) return
    const name = prompt('Rename group:', g.name)?.trim()
    if (!name) return
    await updateGroup(groupId, { name })
    refresh()
  }

  const onDeleteGroup = async (groupId: string) => {
    const g = groups.find(g => g.id === groupId)
    if (!g || !confirm(`Delete group "${g.name}"? Files will be ungrouped, not deleted.`)) return
    await deleteGroup(groupId)
    refresh()
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = files.findIndex(f => f.name === active.id)
    const newIndex = files.findIndex(f => f.name === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const reordered = arrayMove(files, oldIndex, newIndex)
    setFiles(reordered)
    await reorderFiles(reordered.map(f => f.name))
  }

  const groupedFileNames = new Set(groups.flatMap(g => g.files))
  const ungroupedFiles = files.filter(f => !groupedFileNames.has(f.name))

  return (
    <div style={{
      height: '100%', width: 240,
      background: '#0f0f0f', color: '#bfbfbf', borderRight: '1px solid #292929',
      display: 'flex', flexDirection: 'column', position: 'relative',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid #292929', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 600, fontSize: 14, fontFamily: "'Space Grotesk', sans-serif", color: '#bfbfbf' }}>Files</span>
        <button
          onClick={onCreateGroup}
          title="New group"
          style={{ background: 'transparent', border: '1px solid #333', borderRadius: 4, color: '#737373', cursor: 'pointer', padding: '2px 6px', fontSize: 11, fontFamily: "'Space Grotesk', sans-serif" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#555'; (e.currentTarget as HTMLElement).style.color = '#bfbfbf' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#333'; (e.currentTarget as HTMLElement).style.color = '#737373' }}
        >+ Group</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          {/* Groups */}
          {groups.map(g => (
            <GroupSection
              key={g.id}
              group={g}
              files={files}
              currentFile={currentFile}
              onNavigate={onNavigate}
              onDelete={onDelete}
              onContext={(e, name) => setCtxMenu({ x: e.clientX, y: e.clientY, name })}
              onToggle={() => onToggleGroup(g.id)}
              onRenameGroup={() => onRenameGroup(g.id)}
              onDeleteGroup={() => onDeleteGroup(g.id)}
              onGroupContext={(e) => setGroupCtxMenu({ x: e.clientX, y: e.clientY, groupId: g.id, groupName: g.name })}
            />
          ))}

          {/* Ungrouped */}
          {ungroupedFiles.length > 0 && groups.length > 0 && (
            <div style={{ padding: '6px 8px', marginTop: 4 }}>
              <span style={{ color: '#555', fontSize: 11, fontFamily: "'Space Grotesk', sans-serif", textTransform: 'uppercase', letterSpacing: '0.5px' }}>Ungrouped</span>
            </div>
          )}
          <SortableContext items={ungroupedFiles.map(f => f.name)} strategy={verticalListSortingStrategy}>
            {ungroupedFiles.map((f) => (
              <FileItem
                key={f.name}
                file={f}
                isActive={f.name === currentFile}
                onNavigate={onNavigate}
                onDelete={onDelete}
                onContext={(e, name) => setCtxMenu({ x: e.clientX, y: e.clientY, name })}
              />
            ))}
          </SortableContext>

          {files.length === 0 && (
            <div style={{ color: '#737373', fontSize: 13, padding: '12px 8px', textAlign: 'center' }}>No files yet</div>
          )}
        </DndContext>
      </div>

      {/* Right-click context menu */}
      {ctxMenu && (
        <div style={{
          position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 9999,
          background: '#1a1a1a', border: '1px solid #333', borderRadius: 6,
          padding: '4px 0', minWidth: 180, boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        }}>
          <button
            onClick={() => onSetMcpActive(ctxMenu.name)}
            style={{ width: '100%', padding: '8px 14px', background: 'transparent', border: 'none', color: '#d0ebff', cursor: 'pointer', fontSize: 12, textAlign: 'left', fontFamily: "'Space Grotesk', sans-serif" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a2a2a' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >Set MCP Active</button>
          <button
            onClick={() => { onNavigate(ctxMenu.name); setCtxMenu(null) }}
            style={{ width: '100%', padding: '8px 14px', background: 'transparent', border: 'none', color: '#bfbfbf', cursor: 'pointer', fontSize: 12, textAlign: 'left', fontFamily: "'Space Grotesk', sans-serif" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a2a2a' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >Open</button>

          {/* Move to group submenu */}
          {groups.length > 0 && (
            <>
              <div style={{ height: 1, background: '#333', margin: '4px 0' }} />
              <div style={{ padding: '4px 14px', fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: '0.5px', fontFamily: "'Space Grotesk', sans-serif" }}>Move to group</div>
              {groups.map(g => (
                <button
                  key={g.id}
                  onClick={() => onMoveToGroup(ctxMenu.name, g.id)}
                  style={{ width: '100%', padding: '6px 14px', background: 'transparent', border: 'none', color: '#bfbfbf', cursor: 'pointer', fontSize: 12, textAlign: 'left', fontFamily: "'Space Grotesk', sans-serif", display: 'flex', alignItems: 'center', gap: 8 }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a2a2a' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: g.color }} />
                  {g.name}
                </button>
              ))}
              <button
                onClick={() => onMoveToGroup(ctxMenu.name, null)}
                style={{ width: '100%', padding: '6px 14px', background: 'transparent', border: 'none', color: '#737373', cursor: 'pointer', fontSize: 12, textAlign: 'left', fontFamily: "'Space Grotesk', sans-serif", fontStyle: 'italic' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a2a2a' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >Ungrouped</button>
            </>
          )}

          <div style={{ height: 1, background: '#333', margin: '4px 0' }} />
          <button
            onClick={() => { onDelete(ctxMenu.name); setCtxMenu(null) }}
            style={{ width: '100%', padding: '8px 14px', background: 'transparent', border: 'none', color: '#e03131', cursor: 'pointer', fontSize: 12, textAlign: 'left', fontFamily: "'Space Grotesk', sans-serif" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a2a2a' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >Delete</button>
        </div>
      )}

      {/* Right-click group context menu */}
      {groupCtxMenu && (
        <div style={{
          position: 'fixed', left: groupCtxMenu.x, top: groupCtxMenu.y, zIndex: 9999,
          background: '#1a1a1a', border: '1px solid #333', borderRadius: 6,
          padding: '4px 0', minWidth: 160, boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        }}>
          <button
            onClick={() => { onRenameGroup(groupCtxMenu.groupId); setGroupCtxMenu(null) }}
            style={{ width: '100%', padding: '8px 14px', background: 'transparent', border: 'none', color: '#bfbfbf', cursor: 'pointer', fontSize: 12, textAlign: 'left', fontFamily: "'Space Grotesk', sans-serif" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a2a2a' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >Rename Group</button>
          <div style={{ height: 1, background: '#333', margin: '4px 0' }} />
          <button
            onClick={() => { onDeleteGroup(groupCtxMenu.groupId); setGroupCtxMenu(null) }}
            style={{ width: '100%', padding: '8px 14px', background: 'transparent', border: 'none', color: '#e03131', cursor: 'pointer', fontSize: 12, textAlign: 'left', fontFamily: "'Space Grotesk', sans-serif" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a2a2a' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >Remove Group (files kept)</button>
        </div>
      )}

      <div style={{ padding: 12, borderTop: '1px solid #292929' }}>
        <button
          onClick={onCreate}
          style={{ width: '100%', padding: '8px', background: '#fafafa', color: '#0f0f0f', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 500, fontFamily: "'Space Grotesk', sans-serif" }}
        >+ New Canvas</button>
      </div>
    </div>
  )
}

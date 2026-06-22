import { useEffect, useState, useRef } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { bridge } from './bridge/ExcalidrawBridge'
import { Sidebar } from './components/Sidebar'
import { loadFile, saveFile, setActiveFile, getSettings, updateSettings } from './api/files'

// theme palettes — the top bar follows the active theme (light/dark), kept in
// sync with Christopher OS when embedded
const LIGHT_COLORS = {
  bg: '#ffffff',
  fg: '#0a0a0a',
  card: '#ffffff',
  border: '#e8e8e8',
  muted: '#f5f5f5',
  mutedFg: '#737373',
  secondary: '#f5f5f5',
  secondaryFg: '#0a0a0a',
  success: '#16a34a',
  destructive: '#dc2626',
}
const DARK_COLORS = {
  bg: '#0f0f0f',
  fg: '#e8e8e8',
  card: '#171717',
  border: '#2a2a2a',
  muted: '#1c1c1c',
  mutedFg: '#9a9a9a',
  secondary: '#1c1c1c',
  secondaryFg: '#e8e8e8',
  success: '#22c55e',
  destructive: '#f87171',
}

export default function App() {
  const [currentFile, setCurrentFile] = useState<string>(() =>
    window.location.pathname.replace(/^\//, '').trim()
  )
  const [api, setApi] = useState<any>(null)
  // Collapsed by default when EMBEDDED in an iframe (Christopher OS already lists
  // the canvas files in its own Canvas tab); open by default when standalone.
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return window.self === window.top
    } catch {
      return false
    }
  })
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [lastSaveTime, setLastSaveTime] = useState<string>('')
  const sidebarRefreshRef = useRef<(() => void) | null>(null)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('canvas-theme')
    return saved === 'dark' ? 'dark' : 'light'
  })
  const [mcpActiveFile, setMcpActiveFile] = useState<string>('')
  const [autoSync, setAutoSync] = useState<boolean>(() => localStorage.getItem('canvas-autosync') === 'true')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsData, setSettingsData] = useState<{ canvasDir: string; backupDir: string }>({ canvasDir: '', backupDir: '' })
  useEffect(() => { localStorage.setItem('canvas-theme', theme) }, [theme])
  useEffect(() => { localStorage.setItem('canvas-autosync', String(autoSync)) }, [autoSync])
  const isDark = theme === 'dark'
  const colors = isDark ? DARK_COLORS : LIGHT_COLORS
  const btnStyle: React.CSSProperties = {
    padding: '5px 12px', border: `1px solid ${colors.border}`, borderRadius: 6,
    background: colors.secondary, color: colors.fg, cursor: 'pointer',
    fontSize: 12, fontWeight: 500, fontFamily: "'Space Grotesk', sans-serif",
    transition: 'background 0.15s',
  }

  // sync theme with the embedding app (Christopher OS): apply its theme when it
  // posts one, and announce readiness so it pushes the current theme on open
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data
      if (d && d.type === 'cos-theme' && (d.theme === 'dark' || d.theme === 'light')) {
        setTheme(d.theme)
      }
    }
    window.addEventListener('message', onMsg)
    try {
      window.parent?.postMessage({ type: 'cos-canvas-ready' }, '*')
    } catch {
      /* not embedded */
    }
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Fetch initial MCP active file
  useEffect(() => {
    fetch('/api/active-file').then(r => r.json()).then(d => setMcpActiveFile(d.activeFile || '')).catch(() => {})
  }, [])

  // Load file when API ready
  useEffect(() => {
    if (!api || !currentFile) return
    let cancelled = false
    loadFile(currentFile).then((data) => {
      if (cancelled) return
      bridge.loadElements(data.elements || [])
    })
    return () => { cancelled = true }
  }, [api, currentFile])

  const navigate = async (name: string) => {
    if (name === currentFile) return
    if (currentFile) {
      try {
        const els = bridge.getElements()
        if (els.length > 0) await saveFile(currentFile, els)
      } catch {}
    }
    window.location.href = name ? `/${name}` : '/'
  }

  // Ctrl+S — save with capture:true to block browser's native save dialog
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        e.stopPropagation()
        if (!currentFile) return
        setSaveStatus('saving')
        try {
          const els = bridge.getElements()
          await saveFile(currentFile, els)
          setSaveStatus('saved')
          setLastSaveTime(new Date().toLocaleTimeString('en-IN', {
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
          }))
          setTimeout(() => setSaveStatus('idle'), 2000)
        } catch {
          setSaveStatus('error')
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [currentFile])

  // Auto Sync — save every 30s when enabled
  useEffect(() => {
    if (!autoSync || !currentFile) return
    const interval = setInterval(async () => {
      try {
        const els = bridge.getElements()
        if (els.length === 0) return
        await saveFile(currentFile, els)
        setLastSaveTime(new Date().toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
        }))
      } catch {}
    }, 30000)
    return () => clearInterval(interval)
  }, [autoSync, currentFile])

  // Excalidraw refresh on sidebar toggle (fixes click offset)
  useEffect(() => {
    if (!api) return
    const t = setTimeout(() => {
      try { api.refresh() } catch {}
    }, 220)
    return () => clearTimeout(t)
  }, [sidebarOpen, api])

  // WebSocket — live changes from MCP
  useEffect(() => {
    if (!api) return
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)
    ws.onmessage = async (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'active_file_changed') {
          setMcpActiveFile(msg.activeFile || '')
          return
        }
        if ((msg.type === 'elements_added' || msg.type === 'scene_replaced' ||
             msg.type === 'element_updated' || msg.type === 'element_deleted' ||
             msg.type === 'file_deleted') && msg.name && msg.name !== currentFile) return

        if (msg.type === 'elements_added' && Array.isArray(msg.elements)) {
          bridge.addElements(msg.elements)
        } else if (msg.type === 'scene_replaced' && Array.isArray(msg.elements)) {
          bridge.loadElements(msg.elements)
        } else if (msg.type === 'element_updated' && msg.element) {
          bridge.updateElement(msg.element.id, msg.element)
        } else if (msg.type === 'element_deleted' && msg.elementId) {
          bridge.removeElement(msg.elementId)
        } else if (msg.type === 'file_deleted' && msg.name === currentFile) {
          window.location.href = '/'
        } else if (msg.type === 'set_viewport') {
          bridge.setViewport({
            scrollToContent: msg.scrollToContent,
            zoom: msg.zoom, offsetX: msg.offsetX, offsetY: msg.offsetY,
          })
        } else if (msg.type === 'files_added' && Array.isArray(msg.files)) {
          bridge.addFiles(msg.files)
        } else if (msg.type === 'export_image_request' && msg.id) {
          try {
            const data = await bridge.exportImage(msg.format || 'png', msg.background !== false)
            await fetch('/api/export/image/result', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: msg.id, format: msg.format || 'png', data }),
            })
          } catch (e: any) {
            await fetch('/api/export/image/result', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: msg.id, error: e?.message || String(e) }),
            })
          }
        } else if (msg.type === 'mermaid_convert_request' && msg.id) {
          try {
            const result = await bridge.fromMermaid(msg.mermaidDiagram, msg.config)
            if (result.elements?.length && currentFile) {
              await fetch(`/api/files/${encodeURIComponent(currentFile)}/elements`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ elements: result.elements }),
              })
            }
            await fetch('/api/elements/from-mermaid/result', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: msg.id, count: result.elements?.length || 0 }),
            })
          } catch (e: any) {
            await fetch('/api/elements/from-mermaid/result', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: msg.id, error: e?.message || String(e) }),
            })
          }
        }
      } catch {}
    }
    return () => ws.close()
  }, [api, currentFile])

  const sidebarW = sidebarOpen ? 240 : 0

  return (
    <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      {/* ── Header ── */}
      <div style={{
        background: colors.card,
        borderBottom: `1px solid ${colors.border}`,
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
        height: 44,
        zIndex: 100,
      }}>
        {/* Left: hamburger + filename */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={() => { setSidebarOpen((o) => !o); if (!sidebarOpen) sidebarRefreshRef.current?.() }}
            style={{
              background: 'none', border: `1px solid ${colors.border}`, borderRadius: 6,
              padding: '4px 8px', cursor: 'pointer', color: colors.fg, fontSize: 16, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
          >&#x2630;</button>
          <span style={{ fontWeight: 600, fontSize: 16, color: colors.fg, fontFamily: "'Space Grotesk', sans-serif" }}>
            {currentFile || 'Canvas'}
          </span>
          {currentFile && (
            <span style={{
              fontSize: 11, fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500,
              padding: '2px 8px', borderRadius: 4,
              background: mcpActiveFile === currentFile ? '#d3f9d8' : '#ffc9c9',
              color: mcpActiveFile === currentFile ? '#2f9e44' : '#e03131',
              border: `1px solid ${mcpActiveFile === currentFile ? '#b2f2bb' : '#ffa8a8'}`,
            }}>
              MCP: {mcpActiveFile === currentFile ? 'Active' : mcpActiveFile || 'None'}
            </span>
          )}
        </div>

        {/* Right: save status + action buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          {/* Save status */}
          {saveStatus === 'error' && <span style={{ color: colors.destructive }}>Save Failed</span>}
          {saveStatus === 'saving' && <span style={{ color: colors.mutedFg }}>Saving...</span>}
          {lastSaveTime && saveStatus !== 'error' && saveStatus !== 'saving' && (
            <span style={{ color: colors.mutedFg }}>saved {lastSaveTime}</span>
          )}
          {!lastSaveTime && saveStatus === 'idle' && currentFile && (
            <span style={{ color: colors.mutedFg }}>Ctrl+S to save</span>
          )}
          <span style={{ color: colors.border }}>|</span>
          {/* Auto Sync */}
          <button onClick={async () => {
            const next = !autoSync
            setAutoSync(next)
            if (next && currentFile) {
              try {
                const els = bridge.getElements()
                if (els.length > 0) {
                  setSaveStatus('saving')
                  await saveFile(currentFile, els)
                  setSaveStatus('saved')
                  setLastSaveTime(new Date().toLocaleTimeString('en-IN', {
                    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
                  }))
                  setTimeout(() => setSaveStatus('idle'), 2000)
                }
              } catch { setSaveStatus('error') }
            }
          }} style={{
            ...btnStyle,
            background: autoSync ? '#d3f9d8' : '#f5f5f5',
            color: autoSync ? '#2f9e44' : '#0a0a0a',
            borderColor: autoSync ? '#b2f2bb' : '#e8e8e8',
          }}>{autoSync ? 'Sync ON' : 'Sync OFF'}</button>
          {/* Backup */}
          <button onClick={async () => {
            if (!currentFile) return
            const els = bridge.getElements()
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
            await saveFile(`${currentFile}_backup_${ts}`, els)
            alert(`Backup: ${currentFile}_backup_${ts}`)
          }} style={btnStyle}>Backup</button>
          {/* Light/Dark */}
          <button onClick={() => setTheme((t) => t === 'dark' ? 'light' : 'dark')} style={btnStyle}>
            {isDark ? 'Light' : 'Dark'}
          </button>
          {/* MCP Test */}
          <button onClick={async () => {
            try { await fetch('/api/mcp-test', { method: 'POST' }) } catch {}
          }} style={btnStyle}>MCP Test</button>
          {/* Settings */}
          <button onClick={async () => {
            const s = await getSettings()
            setSettingsData({ canvasDir: s.canvasDir || '', backupDir: s.backupDir || '' })
            setSettingsOpen(true)
          }} style={btnStyle}>Settings</button>
          {/* Clear */}
          <button onClick={() => {
            if (!currentFile || !confirm('Clear all elements?')) return
            bridge.clearScene()
          }} style={{ ...btnStyle, color: colors.destructive, borderColor: '#fecaca' }}>Clear</button>
        </div>
      </div>

      {/* ── Body: sidebar + canvas ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {sidebarOpen && (
          <div style={{ width: 240, flexShrink: 0 }}>
            <Sidebar
              currentFile={currentFile}
              onNavigate={navigate}
              onRefresh={(fn) => { sidebarRefreshRef.current = fn }}
            />
          </div>
        )}
        <div style={{ flex: 1, height: '100%', transition: 'margin-left 0.15s ease' }}>
          {currentFile ? (
            <Excalidraw
              theme={theme}
              excalidrawAPI={(a: any) => { setApi(a); bridge.setAPI(a) }}
            />
          ) : (
            <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: colors.mutedFg }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 18, marginBottom: 12 }}>No file selected</div>
                <div style={{ fontSize: 14 }}>Pick a file from the sidebar or click "+ New Canvas"</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Settings Modal */}
      {settingsOpen && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setSettingsOpen(false)}>
          <div style={{
            background: '#fff', borderRadius: 12, padding: 24, width: 500,
            boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
            fontFamily: "'Space Grotesk', sans-serif",
          }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 20px', fontSize: 20, color: '#0a0a0a' }}>Settings</h2>

            <label style={{ display: 'block', fontSize: 13, color: '#737373', marginBottom: 4 }}>
              Canvas Files Path
            </label>
            <input
              value={settingsData.canvasDir}
              onChange={(e) => setSettingsData(s => ({ ...s, canvasDir: e.target.value }))}
              style={{
                width: '100%', padding: '8px 12px', border: '1px solid #e8e8e8', borderRadius: 6,
                fontSize: 14, fontFamily: "'Inter', sans-serif", marginBottom: 16, boxSizing: 'border-box',
              }}
              placeholder="e.g. C:/Users/You/Canvas"
            />

            <label style={{ display: 'block', fontSize: 13, color: '#737373', marginBottom: 4 }}>
              Backup Path
            </label>
            <input
              value={settingsData.backupDir}
              onChange={(e) => setSettingsData(s => ({ ...s, backupDir: e.target.value }))}
              style={{
                width: '100%', padding: '8px 12px', border: '1px solid #e8e8e8', borderRadius: 6,
                fontSize: 14, fontFamily: "'Inter', sans-serif", marginBottom: 24, boxSizing: 'border-box',
              }}
              placeholder="e.g. C:/Users/You/Canvas/_backups"
            />

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setSettingsOpen(false)} style={btnStyle}>Cancel</button>
              <button onClick={async () => {
                try {
                  await updateSettings({ canvasDir: settingsData.canvasDir, backupDir: settingsData.backupDir })
                  setSettingsOpen(false)
                  sidebarRefreshRef.current?.()
                  alert('Settings saved. Files path updated.')
                } catch { alert('Failed to save settings.') }
              }} style={{
                ...btnStyle, background: '#0a0a0a', color: '#fff', borderColor: '#0a0a0a',
              }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

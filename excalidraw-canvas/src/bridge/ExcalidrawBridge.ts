// THE ONLY FILE that imports from @excalidraw/excalidraw type-side.
// Everything else in the app talks to the bridge.
//
// Responsibilities:
// 1. normalize() — fill in every Excalidraw-required field on a partial element,
//    so we never crash convertToExcalidrawElements / renderer with undefined fields
// 2. setAPI() — store the imperative API once Excalidraw mounts
// 3. addElements / clearScene / loadElements — simple verbs callers use
//
// When Excalidraw upgrades, this is the only file that needs a sanity check.

// We deliberately type the API as `any` here. The Excalidraw npm package's
// type exports change between versions; the bridge is the only place this
// ambiguity leaks, so we keep a tight runtime contract via normalize().
type AnyEl = Record<string, any>
type ExcalidrawAPI = any

class ExcalidrawBridge {
  private api: ExcalidrawAPI | null = null

  setAPI(api: ExcalidrawAPI) {
    this.api = api
  }

  getAPI() {
    return this.api
  }

  /** Replace the whole scene (used on file load). */
  loadElements(elements: AnyEl[]) {
    if (!this.api) return
    const normalized = elements.map((el) => this.normalize(el))
    this.api.updateScene({ elements: normalized as any })
  }

  /** Clear the canvas. */
  clearScene() {
    if (!this.api) return
    this.api.updateScene({ elements: [] })
  }

  /** Append elements to the current scene. */
  addElements(partials: AnyEl[]) {
    if (!this.api) return
    const current = this.api.getSceneElements()
    const additions = partials.map((p) => this.normalize(p))
    this.api.updateScene({ elements: [...current, ...additions] as any })
  }

  /** Update one element by id (merges patch into existing). */
  updateElement(id: string, patch: AnyEl) {
    if (!this.api) return
    const els = this.api.getSceneElements()
    const next = els.map((e: AnyEl) => (e.id === id ? this.normalize({ ...e, ...patch, id }) : e))
    this.api.updateScene({ elements: next as any })
  }

  /** Remove one element by id. */
  removeElement(id: string) {
    if (!this.api) return
    const els = this.api.getSceneElements().filter((e: AnyEl) => e.id !== id)
    this.api.updateScene({ elements: els as any })
  }

  /** Scroll/zoom the canvas viewport. */
  setViewport(opts: { scrollToContent?: boolean; zoom?: number; offsetX?: number; offsetY?: number }) {
    if (!this.api) return
    if (opts.scrollToContent) {
      const els = this.api.getSceneElements()
      if (els.length > 0) this.api.scrollToContent(els as any, { fitToViewport: true, animate: true })
      return
    }
    const appState: any = {}
    if (opts.zoom !== undefined) appState.zoom = { value: opts.zoom }
    if (opts.offsetX !== undefined) appState.scrollX = opts.offsetX
    if (opts.offsetY !== undefined) appState.scrollY = opts.offsetY
    if (Object.keys(appState).length > 0) this.api.updateScene({ appState })
  }

  /** Read current scene elements. */
  getElements(): AnyEl[] {
    return this.api ? Array.from(this.api.getSceneElements()) : []
  }

  /** Get current appState (for export). */
  getAppState(): any {
    return this.api ? this.api.getAppState() : {}
  }

  /** Get attached files (image binaries). */
  getFiles(): Record<string, any> {
    return this.api ? this.api.getFiles() : {}
  }

  /** Add files (image binaries) to Excalidraw. */
  addFiles(files: any[]) {
    if (!this.api) return
    this.api.addFiles(files)
  }

  /** Export the current scene as PNG/SVG. Used by image export tools. */
  async exportImage(format: 'png' | 'svg' = 'png', background = true): Promise<string> {
    if (!this.api) throw new Error('Excalidraw not ready')
    const elements = this.api.getSceneElements()
    const appState = { ...this.api.getAppState(), exportBackground: background }
    const files = this.api.getFiles()
    const lib = await import('@excalidraw/excalidraw')
    if (format === 'svg') {
      const svg = await lib.exportToSvg({ elements, appState, files })
      return new XMLSerializer().serializeToString(svg)
    }
    const blob = await lib.exportToBlob({ elements, appState, files, mimeType: 'image/png' })
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  }

  /** Convert a Mermaid diagram to Excalidraw elements (uses npm package). */
  async fromMermaid(mermaidDiagram: string, config?: any): Promise<{ elements: AnyEl[]; files?: any }> {
    const { parseMermaidToExcalidraw } = await import('@excalidraw/mermaid-to-excalidraw')
    const result = await parseMermaidToExcalidraw(mermaidDiagram, config)
    return { elements: result.elements as any[], files: (result as any).files }
  }

  /**
   * Fill in every field Excalidraw needs. The "MCP/data" layer above us provides
   * intent (type, x, y, text, color); we provide the wire-level completeness.
   * Why this works: spreading user fields LAST means user values win, defaults
   * only fill in what's missing.
   */
  private normalize(raw: AnyEl): AnyEl {
    const isLineLike = raw.type === 'line' || raw.type === 'arrow' || raw.type === 'freedraw'
    const out: AnyEl = {
      // identity
      id: raw.id ?? this.generateId(),
      // entropy / versioning Excalidraw uses for reconciliation
      seed: raw.seed ?? Math.floor(Math.random() * 2_000_000_000),
      version: raw.version ?? 1,
      versionNonce: raw.versionNonce ?? Math.floor(Math.random() * 2_000_000_000),
      isDeleted: raw.isDeleted ?? false,
      updated: raw.updated ?? Date.now(),
      // structural
      angle: raw.angle ?? 0,
      width: raw.width ?? 100,
      height: raw.height ?? 100,
      // associations / arrays Excalidraw .forEach()'s on
      groupIds: raw.groupIds ?? [],
      boundElements: raw.boundElements ?? null,
      frameId: raw.frameId ?? null,
      // appearance
      strokeColor: raw.strokeColor ?? '#1e1e1e',
      backgroundColor: raw.backgroundColor ?? 'transparent',
      fillStyle: raw.fillStyle ?? 'solid',
      strokeWidth: raw.strokeWidth ?? 1,
      strokeStyle: raw.strokeStyle ?? 'solid',
      roughness: raw.roughness ?? 1,
      opacity: raw.opacity ?? 100,
      roundness: raw.roundness ?? null,
      // misc
      link: raw.link ?? null,
      locked: raw.locked ?? false,
      customData: raw.customData ?? null,
      ...raw,
    }
    if (isLineLike && (!Array.isArray(out.points) || out.points.length === 0)) {
      out.points = [
        [0, 0],
        [out.width != null ? out.width : 100, out.height != null ? out.height : 0],
      ]
    }

    // Type-specific completeness — Excalidraw silently fails to render
    // elements missing per-type required fields. Generic defaults (above)
    // cover all types; these add what each specific type needs.
    if (out.type === 'text') {
      const text = typeof out.text === 'string' ? out.text : ''
      out.text = text
      out.originalText = out.originalText ?? text
      out.fontSize = out.fontSize ?? 20
      out.fontFamily = out.fontFamily ?? 5 // 5 = Excalifont (default sans)
      out.textAlign = out.textAlign ?? 'left'
      out.verticalAlign = out.verticalAlign ?? 'top'
      out.lineHeight = out.lineHeight ?? 1.25
      out.containerId = out.containerId ?? null
      out.autoResize = out.autoResize ?? true
      // baseline ≈ fontSize * 0.85; Excalidraw recomputes on render but it must exist
      out.baseline = out.baseline ?? Math.round((out.fontSize as number) * 0.85)
      // Excalidraw uses width/height to CLIP text rendering. Too small = text
      // cut off. Too large = fine (autoResize shrinks to fit on first render).
      // ALWAYS overestimate. Excalidraw will recompute the real box when the
      // user interacts, but the initial render needs room.
      if (!raw.width) {
        const lines = text.split('\n')
        const maxLen = Math.max(1, ...lines.map((l: string) => l.length))
        out.width = Math.max(200, maxLen * (out.fontSize as number) * 0.7)
      }
      if (!raw.height) {
        const lines = text.split('\n')
        out.height = Math.max(50, lines.length * (out.fontSize as number) * (out.lineHeight as number) * 1.5)
      }
    }

    if (out.type === 'rectangle' || out.type === 'ellipse' || out.type === 'diamond') {
      // boundElements should be an array (not null) for shapes that may host text
      if (out.boundElements === null) out.boundElements = []
    }

    return out
  }

  private generateId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }
}

export const bridge = new ExcalidrawBridge()
export type { ExcalidrawBridge }

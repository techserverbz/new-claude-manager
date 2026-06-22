import { ChevronRight, GripVertical } from 'lucide-react'

/**
 * SidebarRow — the slim manifesto-hybrid list row (~56px, ghost).
 * No card plate, no border box: a single full-width button with a brass
 * '№NN' index, an optional brass ✦ when selected, an uppercase mono title,
 * a trailing ChevronRight, and a faint subtitle on the second line.
 * Selected rows carry a 2px brass left accent + faint surface tint; the
 * unselected accent is transparent so the row width never jumps.
 */

export interface SidebarRowProps {
  /** zero-based position in its list — drives the '№NN' index */
  index: number
  title: string
  subtitle: string
  selected?: boolean
  /** a live shell is running for this row — shows a green blinking marker */
  active?: boolean
  /** a session row nested under its project — tighter, no '№NN' index */
  nested?: boolean
  /** when defined the trailing chevron is a disclosure caret (down when open) */
  expanded?: boolean
  /** optional color-label hex ('#rrggbb') — renders a small dot before the title */
  color?: string
  onSelect?: () => void
  /** right-click handler (context menu) */
  onContextMenu?: (e: import('react').MouseEvent) => void
  /** double-click handler (e.g. rename inline) */
  onDoubleClick?: () => void
  /** drag-to-reorder (sidebar sessions) */
  draggable?: boolean
  isDragOver?: boolean
  onDragStart?: (e: import('react').DragEvent) => void
  onDragOver?: (e: import('react').DragEvent) => void
  onDragLeave?: (e: import('react').DragEvent) => void
  onDrop?: (e: import('react').DragEvent) => void
  onDragEnd?: (e: import('react').DragEvent) => void
}

export function SidebarRow({
  index,
  title,
  subtitle,
  selected,
  active,
  nested,
  expanded,
  color,
  onSelect,
  onContextMenu,
  onDoubleClick,
  draggable,
  isDragOver,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: SidebarRowProps) {
  const num = String(index + 1).padStart(2, '0')
  const isSelected = selected === true
  const isActive = active === true
  const isNested = nested === true
  const isDisclosure = expanded !== undefined

  return (
    <button
      type="button"
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      aria-pressed={isSelected}
      aria-expanded={isDisclosure ? expanded : undefined}
      className={`w-full cursor-pointer border-b border-hairline-s pr-2.5 text-left transition-colors duration-150 ${
        isNested ? 'py-2' : 'py-2.5'
      } ${
        isDragOver
          ? 'border-l-2 border-l-brass bg-brass/10'
          : isSelected
            ? 'border-l-2 border-l-brass bg-surface-2/30 pl-2'
            : 'border-l-2 border-l-transparent pl-2 hover:bg-surface-2/40'
      } ${isDragOver ? 'pl-2' : ''}`}
    >
      {/* — top line — */}
      <div className="flex items-center gap-2">
        {draggable === true && (
          <GripVertical
            className="-ml-0.5 h-3.5 w-3 shrink-0 text-sand-dim transition-colors duration-150 group-hover:text-sand"
            aria-hidden="true"
          />
        )}
        {!isNested && <span className="font-mono text-[10px] text-brass">№{num}</span>}
        {/* fixed-width slot so the title never shifts sideways when the live
            dot appears/disappears — the dot is 7px; reserve it always and only
            toggle visibility */}
        <span
          aria-hidden={isActive ? undefined : true}
          className="flex w-[7px] shrink-0 items-center justify-center"
        >
          {isActive ? (
            <span className="mo-live-dot" role="img" aria-label="Live shell running" />
          ) : null}
        </span>
        {typeof color === 'string' && color !== '' && (
          <span
            aria-hidden="true"
            style={{ background: color }}
            className="h-2.5 w-2.5 shrink-0 rounded-full"
          />
        )}
        <span
          className={`min-w-0 flex-1 truncate font-mono uppercase tracking-[0.08em] text-parchment ${
            isNested ? 'text-[11px]' : 'text-[12px]'
          }`}
        >
          {title}
        </span>
        {/* selected marker — sits AFTER the name */}
        {isSelected ? (
          <span aria-hidden="true" className="shrink-0 font-mono text-[10px] text-brass">
            ✦
          </span>
        ) : null}
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 text-sand-dim transition-transform duration-200 ${
            isDisclosure && expanded === true ? 'rotate-90' : ''
          }`}
          aria-hidden="true"
        />
      </div>

      {/* — second line — */}
      <p
        className={`mt-1 truncate font-mono text-sand ${isNested ? 'text-[10px]' : 'text-[11px]'}`}
      >
        {subtitle}
      </p>
    </button>
  )
}

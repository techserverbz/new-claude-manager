import type { CSSProperties } from 'react'
import { mulberry32 } from '../lib/prng'

/**
 * Ambience — fixed, full-viewport observatory atmosphere.
 * Nebula radial gradients + parchment paper grain + 18 twinkling
 * star specks at deterministic positions. Pointer-events: none;
 * sits behind everything at z-0.
 */

const STAR_COUNT = 18

/* deterministic speck placement — one PRNG iterated across all stars,
   so positions scatter instead of lining up on LCG diagonals */
const STARS: CSSProperties[] = (() => {
  const rand = mulberry32(0x0b1020)
  return Array.from({ length: STAR_COUNT }, (_, i) => {
    const top = rand() * 100
    const left = rand() * 100
    const size = (i % 3) + 1
    const duration = 2 + ((i * 13) % 5) // 2–6s
    const delay = (i * 0.3) % 4
    return {
      top: `${top.toFixed(3)}%`,
      left: `${left.toFixed(3)}%`,
      width: `${size}px`,
      height: `${size}px`,
      animationDuration: `${duration}s`,
      animationDelay: `${delay}s`,
    }
  })
})()

export function Ambience() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      <div className="mo-nebula" />
      <div className="mo-grain" />
      {STARS.map((style, i) => (
        <span key={i} className="mo-star" style={style} />
      ))}
    </div>
  )
}

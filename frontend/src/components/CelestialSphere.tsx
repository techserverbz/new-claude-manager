import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { mulberry32 } from '../lib/prng'
import type { Theme } from '../App'

/**
 * CelestialSphere — three.js WebGL port of the source design's
 * wireframe icosphere + particle field (HeroSphereBeige), per spec:
 *
 *  - WebGLRenderer({ antialias: true, alpha: true })
 *  - PerspectiveCamera(75, aspect, 0.1, 1000) at z = 5
 *  - IcosahedronGeometry(2, 4) with MeshPhongMaterial
 *    { color: 0xEAD9B5, wireframe, transparent, opacity: 0.42, DoubleSide }
 *  - 1,000-point BufferGeometry cube of side 7 with PointsMaterial
 *    { size: 0.018, color: 0xF2E6C2, opacity: 0.8 }
 *  - AmbientLight(0x9C9180) + DirectionalLight(0xF2E6C2, 1) at (1, 1, 1)
 *  - per-frame: sphere.rotation.y += 0.003 (+ mouse.x parallax),
 *    sphere.rotation.x += 0.001 (+ mouse.y parallax),
 *    particles.rotation.y += 0.001
 *  - mouse parallax via useRef (the spec's porting note — the
 *    original's useState capture was inert inside the rAF closure)
 *
 * Documented improvements kept from the earlier port:
 *  - deterministic PRNG so the particle cloud is identical every mount
 *  - prefers-reduced-motion renders a single static frame, and the
 *    media query is observed live (loop starts/stops on OS toggle)
 *  - devicePixelRatio changes (zoom / monitor moves) re-size the
 *    backing store; rotation accumulators wrap to avoid float drift
 */

const PARTICLE_COUNT = 1000
const TAU = Math.PI * 2

/* palette per theme — dark: cream wireframe / cream specks;
   light: warm-ink wireframe / brass specks (1Cal HeroSphereBeige) */
const SPHERE_COLORS: Record<Theme, { sphere: number; particles: number }> = {
  dark: { sphere: 0xead9b5, particles: 0xf2e6c2 },
  light: { sphere: 0x1a1611, particles: 0xb7891e },
}

interface CelestialSphereProps {
  /** rendered square size in CSS pixels */
  size?: number
  theme?: Theme
  className?: string
}

export function CelestialSphere({ size = 280, theme = 'light', className }: CelestialSphereProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  /* mouse lives in a ref so the rAF closure always reads fresh values */
  const mouseRef = useRef({ x: 0, y: 0 })
  /* theme recolors materials without tearing down the WebGL context */
  const themeRef = useRef<Theme>(theme)
  themeRef.current = theme
  const recolorRef = useRef<((t: Theme) => void) | null>(null)
  const [webglFailed, setWebglFailed] = useState(false)

  useEffect(() => {
    recolorRef.current?.(theme)
  }, [theme])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    /* WebGL is unavailable on some machines (no GPU / disabled / headless) — a
       thrown WebGLRenderer would crash the whole React tree (white screen on the
       new-chat/empty screen where this renders). Fall back to a static SVG. */
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch {
      setWebglFailed(true)
      return
    }
    renderer.setPixelRatio(Math.max(1, window.devicePixelRatio || 1))
    renderer.setSize(size, size)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000)
    camera.position.z = 5

    /* — wireframe icosphere — */
    const sphereGeometry = new THREE.IcosahedronGeometry(2, 4)
    const sphereMaterial = new THREE.MeshPhongMaterial({
      color: SPHERE_COLORS[themeRef.current].sphere,
      wireframe: true,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
    })
    const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial)
    sphere.rotation.x = 0.35
    sphere.rotation.y = 0.6
    scene.add(sphere)

    /* — particle field: uniform cube of side 7 (deterministic) — */
    const rand = mulberry32(0x0b1020)
    const positions = new Float32Array(PARTICLE_COUNT * 3)
    for (let i = 0; i < PARTICLE_COUNT * 3; i++) {
      positions[i] = (rand() - 0.5) * 7
    }
    const particleGeometry = new THREE.BufferGeometry()
    particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const particleMaterial = new THREE.PointsMaterial({
      size: 0.018,
      color: SPHERE_COLORS[themeRef.current].particles,
      transparent: true,
      opacity: 0.8,
    })
    const particles = new THREE.Points(particleGeometry, particleMaterial)
    scene.add(particles)

    /* — phong lighting — */
    const ambient = new THREE.AmbientLight(0x9c9180)
    scene.add(ambient)
    const directional = new THREE.DirectionalLight(0xf2e6c2, 1)
    directional.position.set(1, 1, 1)
    scene.add(directional)

    const renderFrame = () => renderer.render(scene, camera)

    /* recolor on theme change (no context teardown); repaint if idle */
    recolorRef.current = (t: Theme) => {
      sphereMaterial.color.set(SPHERE_COLORS[t].sphere)
      particleMaterial.color.set(SPHERE_COLORS[t].particles)
      if (!running) renderFrame()
    }

    /* — animation loop — */
    let raf = 0
    const animate = () => {
      sphere.rotation.y = (sphere.rotation.y + 0.003 + mouseRef.current.x * 0.001) % TAU
      sphere.rotation.x = (sphere.rotation.x + 0.001 + mouseRef.current.y * 0.001) % TAU
      particles.rotation.y = (particles.rotation.y + 0.001) % TAU
      renderFrame()
      raf = requestAnimationFrame(animate)
    }

    const onMouseMove = (e: MouseEvent) => {
      mouseRef.current.x = (e.clientX / window.innerWidth) * 2 - 1
      mouseRef.current.y = -(e.clientY / window.innerHeight) * 2 + 1
    }

    let running = false
    const startLoop = () => {
      if (running) return
      running = true
      window.addEventListener('mousemove', onMouseMove)
      raf = requestAnimationFrame(animate)
    }
    const stopLoop = () => {
      if (!running) return
      running = false
      cancelAnimationFrame(raf)
      window.removeEventListener('mousemove', onMouseMove)
    }

    /* — reduced motion: observed live, not just sampled at mount — */
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onMotionChange = () => {
      if (motionQuery.matches) {
        stopLoop()
        renderFrame() // one static, fully-composed frame
      } else {
        startLoop()
      }
    }
    motionQuery.addEventListener('change', onMotionChange)
    onMotionChange()

    /* — devicePixelRatio changes (browser zoom, monitor moves) — */
    let dprQuery: MediaQueryList | null = null
    const onDprChange = () => {
      renderer.setPixelRatio(Math.max(1, window.devicePixelRatio || 1))
      renderer.setSize(size, size)
      if (!running) renderFrame()
      watchDpr() // re-register against the new ratio
    }
    const watchDpr = () => {
      dprQuery?.removeEventListener('change', onDprChange)
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      dprQuery.addEventListener('change', onDprChange)
    }
    watchDpr()

    return () => {
      recolorRef.current = null
      stopLoop()
      motionQuery.removeEventListener('change', onMotionChange)
      dprQuery?.removeEventListener('change', onDprChange)
      sphereGeometry.dispose()
      sphereMaterial.dispose()
      particleGeometry.dispose()
      particleMaterial.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [size])

  if (webglFailed) {
    return (
      <div
        aria-hidden="true"
        className={className}
        style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.3 }}
      >
        <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="0.5">
          <circle cx="50" cy="50" r="40" />
          <ellipse cx="50" cy="50" rx="40" ry="16" />
          <ellipse cx="50" cy="50" rx="16" ry="40" />
        </svg>
      </div>
    )
  }

  return (
    <div
      ref={mountRef}
      aria-hidden="true"
      className={className}
      style={{ width: size, height: size }}
    />
  )
}

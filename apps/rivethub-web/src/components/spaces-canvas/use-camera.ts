/**
 * Camera runtime: rAF fly, pointer pan, pinch, wheel, and resize re-fit.
 * Writes the mock's `--z`, `--inv`, `--live` custom properties on the world
 * element (plus the translate/scale transform). Hand zoom reports an altitude
 * of everything or space; it never enters thread.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  altitudeFromZoom,
  apply,
  fit,
  flyStep,
  zoomAround,
  type Altitude,
  type Cam,
  type Rect,
  type Viewport,
} from './camera.js'

const FLY_MS = 320
const PAN_CANCEL_PX = 5

export interface CameraTarget {
  /** Changes when the user navigates or the framed rect changes. */
  key: string
  mode: Altitude
  rect: Rect
}

export function useCamera(opts: {
  stageRef: RefObject<HTMLDivElement | null>
  worldRef: RefObject<HTMLDivElement | null>
  target: CameraTarget | null
  /** Fired when a fly that was started for a thread target lands. */
  onLand: () => void
  /** Hand zoom / pan-out. `space` also means "left thread". */
  onHandAltitude: (next: 'everything' | 'space') => void
}): {
  vp: Viewport
  cam: Cam
  /** Set while a pointer drag has moved far enough to cancel a click. */
  movedRef: RefObject<boolean>
  /** Parent sets this before a navigation so the next target change flies. */
  navRef: RefObject<boolean>
  /** Parent sets this on a hand gesture so the camera is not snapped back. */
  detachedRef: RefObject<boolean>
} {
  const { stageRef, worldRef, target, onLand, onHandAltitude } = opts
  const [vp, setVp] = useState<Viewport>({ w: 1280, h: 800 })
  const [cam, setCam] = useState<Cam>({ cx: 0, cy: 0, z: 0.2 })
  const camRef = useRef(cam)
  const vpRef = useRef(vp)
  const movedRef = useRef(false)
  const navRef = useRef(false)
  const detachedRef = useRef(false)
  const modeRef = useRef<Altitude>(target?.mode ?? 'everything')
  const flyToken = useRef(0)
  const onLandRef = useRef(onLand)
  const onHandRef = useRef(onHandAltitude)
  onLandRef.current = onLand
  onHandRef.current = onHandAltitude
  modeRef.current = target?.mode ?? modeRef.current
  vpRef.current = vp

  const paint = useCallback(
    (next: Cam, view: Viewport) => {
      const world = worldRef.current
      const stage = stageRef.current
      if (!world) return
      const { tx, ty, z, live } = apply(next, view)
      const inv = z === 0 ? 1 : 1 / z
      world.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`
      world.style.setProperty('--z', String(z))
      world.style.setProperty('--inv', String(inv))
      world.style.setProperty('--live', String(live))
      if (stage) {
        const step = 48 * z
        const dotA = step < 9 ? 0 : Math.min(0.4, (step - 9) / 34)
        stage.style.setProperty('--dot-a', String(dotA))
        stage.style.backgroundSize = `${step}px ${step}px`
        stage.style.backgroundPosition = `${tx}px ${ty}px`
      }
    },
    [stageRef, worldRef],
  )

  const commit = useCallback(
    (next: Cam) => {
      camRef.current = next
      paint(next, vpRef.current)
      setCam(next)
    },
    [paint],
  )

  const fly = useCallback(
    (to: Cam, land?: () => void) => {
      const token = ++flyToken.current
      const from = camRef.current
      const reduce =
        typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      const dur = reduce ? 0 : FLY_MS
      const t0 = performance.now()
      const step = (now: number): void => {
        if (flyToken.current !== token) return
        const t = dur === 0 ? 1 : Math.min(1, (now - t0) / dur)
        commit(flyStep(from, to, t))
        if (t < 1) requestAnimationFrame(step)
        else land?.()
      }
      requestAnimationFrame(step)
    },
    [commit],
  )

  const snap = useCallback(
    (to: Cam) => {
      flyToken.current += 1
      commit(to)
    },
    [commit],
  )

  const flyRef = useRef(fly)
  const snapRef = useRef(snap)
  const targetRef = useRef(target)
  flyRef.current = fly
  snapRef.current = snap
  targetRef.current = target

  useEffect(() => {
    paint(camRef.current, vp)
  }, [cam, vp, paint])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage || typeof ResizeObserver === 'undefined') return
    const read = (): void => {
      const w = stage.clientWidth
      const h = stage.clientHeight
      if (w < 40 || h < 40) return
      setVp((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [stageRef])

  const targetKey = target?.key ?? ''
  const seen = useRef(false)
  const vpSeen = useRef('')
  useEffect(() => {
    const framed = targetRef.current
    if (!framed) return
    const to = fit(framed.rect, framed.mode, vpRef.current)
    const vpKey = `${vpRef.current.w}x${vpRef.current.h}`
    const resized = seen.current && vpSeen.current !== vpKey
    vpSeen.current = vpKey
    if (!seen.current) {
      seen.current = true
      if (framed.mode === 'thread') flyRef.current(to, () => onLandRef.current())
      else snapRef.current(to)
      return
    }
    if (resized) {
      detachedRef.current = false
      snapRef.current(to)
      if (framed.mode === 'thread') onLandRef.current()
      return
    }
    if (navRef.current) {
      navRef.current = false
      detachedRef.current = false
      flyRef.current(to, framed.mode === 'thread' ? () => onLandRef.current() : undefined)
      return
    }
    if (!detachedRef.current) snapRef.current(to)
    // `target` is read through targetRef. Depending on the object would
    // refit on every parent render; key + viewport is the real input.
  }, [targetKey, vp.w, vp.h])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const ptrs = new Map<number, { x: number; y: number }>()
    let drag: { x: number; y: number; moved: boolean } | null = null
    let pinch: number | null = null

    const local = (e: PointerEvent): { x: number; y: number } => {
      const r = stage.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const hand = (next: Cam): void => {
      flyToken.current += 1
      detachedRef.current = true
      commit(next)
      const altitude = altitudeFromZoom(next.z)
      if (modeRef.current === 'thread' || modeRef.current !== altitude) {
        onHandRef.current(altitude)
      }
    }

    const onDown = (e: PointerEvent): void => {
      const targetEl = e.target instanceof Element ? e.target : null
      if (targetEl?.closest('[data-hud]')) return
      if (modeRef.current === 'thread' && targetEl?.closest('[data-thread-live]')) return
      stage.setPointerCapture(e.pointerId)
      const p = local(e)
      ptrs.set(e.pointerId, p)
      if (ptrs.size === 1) {
        drag = { ...p, moved: false }
        movedRef.current = false
      } else if (ptrs.size === 2) {
        drag = null
        const [a, b] = [...ptrs.values()]
        pinch = Math.hypot(a.x - b.x, a.y - b.y)
      }
    }
    const onMove = (e: PointerEvent): void => {
      if (!ptrs.has(e.pointerId)) return
      const p = local(e)
      const prev = ptrs.get(e.pointerId)
      ptrs.set(e.pointerId, p)
      if (pinch !== null && ptrs.size === 2) {
        const [a, b] = [...ptrs.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (pinch > 0) {
          hand(
            zoomAround(
              camRef.current,
              { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
              d / pinch,
              vpRef.current,
            ),
          )
        }
        pinch = d
        return
      }
      if (!drag || !prev) return
      if (!drag.moved && Math.hypot(p.x - drag.x, p.y - drag.y) > PAN_CANCEL_PX) {
        drag.moved = true
        movedRef.current = true
        stage.classList.add('is-panning')
        if (modeRef.current === 'thread') onHandRef.current('space')
      }
      if (drag.moved) {
        flyToken.current += 1
        detachedRef.current = true
        const z = camRef.current.z || 0.04
        commit({
          cx: camRef.current.cx - (p.x - prev.x) / z,
          cy: camRef.current.cy - (p.y - prev.y) / z,
          z: camRef.current.z,
        })
      }
    }
    const onUp = (e: PointerEvent): void => {
      ptrs.delete(e.pointerId)
      if (ptrs.size < 2) pinch = null
      drag = null
      stage.classList.remove('is-panning')
    }
    const onWheel = (e: WheelEvent): void => {
      const targetEl = e.target instanceof Element ? e.target : null
      if (targetEl?.closest('[data-hud]')) return
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const p = local(e as unknown as PointerEvent)
        hand(zoomAround(camRef.current, p, Math.exp(-e.deltaY * 0.01), vpRef.current))
        return
      }
      if (modeRef.current === 'thread') return
      e.preventDefault()
      flyToken.current += 1
      detachedRef.current = true
      const z = camRef.current.z || 0.04
      commit({
        cx: camRef.current.cx + e.deltaX / z,
        cy: camRef.current.cy + e.deltaY / z,
        z: camRef.current.z,
      })
    }

    stage.addEventListener('pointerdown', onDown)
    stage.addEventListener('pointermove', onMove)
    stage.addEventListener('pointerup', onUp)
    stage.addEventListener('pointercancel', onUp)
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      stage.removeEventListener('pointerdown', onDown)
      stage.removeEventListener('pointermove', onMove)
      stage.removeEventListener('pointerup', onUp)
      stage.removeEventListener('pointercancel', onUp)
      stage.removeEventListener('wheel', onWheel)
    }
  }, [stageRef, commit])

  return { vp, cam, movedRef, navRef, detachedRef }
}

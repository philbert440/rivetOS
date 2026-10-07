/**
 * Camera runtime: rAF fly, pointer pan, pinch, wheel, and resize re-fit.
 * Writes the mock's `--z`, `--inv`, `--live` custom properties on the world
 * element (plus the translate/scale transform). Hand zoom reports an altitude
 * of everything or space; it never enters thread.
 *
 * Pointer capture waits until the drag passes the pan threshold, so an
 * unmoved pointerup still selects the tile it went down on. A snap that
 * cancels a fly toward Thread keeps that fly's landing and runs it once the
 * camera is on the thread target.
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

function tileIdFrom(target: EventTarget | null): string | null {
  const el = target instanceof Element ? target : null
  return el?.closest('[data-tile]')?.getAttribute('data-tile') ?? null
}

export function useCamera(opts: {
  stageRef: RefObject<HTMLDivElement | null>
  worldRef: RefObject<HTMLDivElement | null>
  target: CameraTarget | null
  /** Fired when a fly that was started for a thread target lands. */
  onLand: () => void
  /** Hand zoom / pan-out. `space` also means "left thread". */
  onHandAltitude: (next: 'everything' | 'space') => void
  /** Unmoved pointerup (`up`) or a double-click (`double`) on a tile. */
  onTileGesture: (id: string, kind: 'up' | 'double') => void
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
  const { stageRef, worldRef, target, onLand, onHandAltitude, onTileGesture } = opts
  const [vp, setVp] = useState<Viewport>({ w: 1280, h: 800 })
  const [cam, setCam] = useState<Cam>({ cx: 0, cy: 0, z: 0.2 })
  const camRef = useRef(cam)
  const vpRef = useRef(vp)
  const movedRef = useRef(false)
  const navRef = useRef(false)
  const detachedRef = useRef(false)
  const modeRef = useRef<Altitude>(target?.mode ?? 'everything')
  const flyToken = useRef(0)
  const rafRef = useRef<number | null>(null)
  /** Landing of a fly a snap/retarget has not settled yet. */
  const pendingLand = useRef<(() => void) | undefined>(undefined)
  const onLandRef = useRef(onLand)
  const onHandRef = useRef(onHandAltitude)
  const gestureRef = useRef(onTileGesture)
  onLandRef.current = onLand
  onHandRef.current = onHandAltitude
  gestureRef.current = onTileGesture
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

  const cancelFrame = useCallback(() => {
    if (rafRef.current === null) return
    cancelAnimationFrame(rafRef.current)
    rafRef.current = null
  }, [])

  const fly = useCallback(
    (to: Cam, land?: () => void) => {
      const token = ++flyToken.current
      pendingLand.current = land
      cancelFrame()
      const from = camRef.current
      const reduce =
        typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      const dur = reduce ? 0 : FLY_MS
      const t0 = performance.now()
      const step = (now: number): void => {
        if (flyToken.current !== token) return
        const t = dur === 0 ? 1 : Math.min(1, (now - t0) / dur)
        commit(flyStep(from, to, t))
        if (t < 1) {
          rafRef.current = requestAnimationFrame(step)
          return
        }
        rafRef.current = null
        const cb = pendingLand.current
        pendingLand.current = undefined
        cb?.()
      }
      rafRef.current = requestAnimationFrame(step)
    },
    [cancelFrame, commit],
  )

  const snap = useCallback(
    (to: Cam) => {
      flyToken.current += 1
      cancelFrame()
      commit(to)
    },
    [cancelFrame, commit],
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
    const settleThread = (carried: (() => void) | undefined): void => {
      pendingLand.current = undefined
      if (framed.mode !== 'thread') return
      ;(carried ?? (() => onLandRef.current()))()
    }
    if (!seen.current) {
      seen.current = true
      if (framed.mode === 'thread') flyRef.current(to, () => onLandRef.current())
      else snapRef.current(to)
      return
    }
    if (resized) {
      detachedRef.current = false
      const carried = pendingLand.current
      snapRef.current(to)
      settleThread(carried)
      return
    }
    if (navRef.current) {
      navRef.current = false
      detachedRef.current = false
      flyRef.current(to, framed.mode === 'thread' ? () => onLandRef.current() : undefined)
      return
    }
    if (!detachedRef.current) {
      const carried = pendingLand.current
      snapRef.current(to)
      // A reorder mid-fly changes the framed rect and snaps. The landing
      // still belongs to the thread the fly was heading for.
      if (framed.mode === 'thread' && carried) {
        pendingLand.current = undefined
        carried()
      } else {
        pendingLand.current = undefined
      }
    }
    // `target` is read through targetRef. Depending on the object would
    // refit on every parent render; key + viewport is the real input.
  }, [targetKey, vp.w, vp.h])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const ptrs = new Map<number, { x: number; y: number }>()
    let drag: { x: number; y: number; moved: boolean } | null = null
    let pinch: number | null = null
    let pressedId: string | null = null

    const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
      const r = stage.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const hand = (next: Cam): void => {
      flyToken.current += 1
      cancelFrame()
      pendingLand.current = undefined
      detachedRef.current = true
      commit(next)
      const altitude = altitudeFromZoom(next.z)
      if (modeRef.current === 'thread' || modeRef.current !== altitude) {
        onHandRef.current(altitude)
      }
    }
    const exempt = (targetEl: Element | null): boolean => {
      if (targetEl?.closest('[data-hud]')) return true
      if (modeRef.current === 'thread' && targetEl?.closest('[data-thread-live]')) return true
      return false
    }

    const onDown = (e: PointerEvent): void => {
      const targetEl = e.target instanceof Element ? e.target : null
      if (exempt(targetEl)) return
      const p = local(e)
      ptrs.set(e.pointerId, p)
      pressedId = tileIdFrom(e.target)
      if (ptrs.size === 1) {
        drag = { ...p, moved: false }
        movedRef.current = false
      } else if (ptrs.size === 2) {
        drag = null
        pressedId = null
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
        stage.setPointerCapture(e.pointerId)
        if (modeRef.current === 'thread') onHandRef.current('space')
      }
      if (drag.moved) {
        flyToken.current += 1
        cancelFrame()
        pendingLand.current = undefined
        detachedRef.current = true
        const z = camRef.current.z || 0.04
        commit({
          cx: camRef.current.cx - (p.x - prev.x) / z,
          cy: camRef.current.cy - (p.y - prev.y) / z,
          z: camRef.current.z,
        })
      }
    }
    const endPtr = (e: PointerEvent, cancel: boolean): void => {
      const id = pressedId
      const wasDrag = drag?.moved ?? false
      ptrs.delete(e.pointerId)
      if (ptrs.size < 2) pinch = null
      if (ptrs.size === 0) {
        drag = null
        pressedId = null
        stage.classList.remove('is-panning')
      }
      if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId)
      if (!cancel && !wasDrag && id && ptrs.size === 0) gestureRef.current(id, 'up')
    }
    const onUp = (e: PointerEvent): void => {
      endPtr(e, false)
    }
    const onCancel = (e: PointerEvent): void => {
      endPtr(e, true)
    }
    const onDbl = (e: MouseEvent): void => {
      const targetEl = e.target instanceof Element ? e.target : null
      if (exempt(targetEl)) return
      const id = tileIdFrom(e.target)
      if (id) gestureRef.current(id, 'double')
    }
    const onClick = (e: MouseEvent): void => {
      // Pointerup already handled the mouse. detail 0 is a keyboard click.
      if (e.detail !== 0) return
      const targetEl = e.target instanceof Element ? e.target : null
      if (exempt(targetEl)) return
      const id = tileIdFrom(e.target)
      if (id) gestureRef.current(id, 'up')
    }
    const onWheel = (e: WheelEvent): void => {
      const targetEl = e.target instanceof Element ? e.target : null
      if (targetEl?.closest('[data-hud]')) return
      // Pinch-zoom (ctrl/meta + wheel) inside the focused thread must not
      // pull the camera out of Thread. Same exemption as pointerdown.
      if (modeRef.current === 'thread' && targetEl?.closest('[data-thread-live]')) return
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const p = local(e)
        hand(zoomAround(camRef.current, p, Math.exp(-e.deltaY * 0.01), vpRef.current))
        return
      }
      if (modeRef.current === 'thread') return
      e.preventDefault()
      flyToken.current += 1
      cancelFrame()
      pendingLand.current = undefined
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
    stage.addEventListener('pointercancel', onCancel)
    stage.addEventListener('dblclick', onDbl)
    stage.addEventListener('click', onClick)
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      stage.removeEventListener('pointerdown', onDown)
      stage.removeEventListener('pointermove', onMove)
      stage.removeEventListener('pointerup', onUp)
      stage.removeEventListener('pointercancel', onCancel)
      stage.removeEventListener('dblclick', onDbl)
      stage.removeEventListener('click', onClick)
      stage.removeEventListener('wheel', onWheel)
    }
  }, [stageRef, cancelFrame, commit])

  useEffect(() => {
    return () => {
      flyToken.current += 1
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      pendingLand.current = undefined
    }
  }, [])

  return { vp, cam, movedRef, navRef, detachedRef }
}

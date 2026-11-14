// Where the camera is, and how hands move it.
//
// Left alone, the camera sways gently from side to side. The moment someone
// touches it (a click is enough) the sway stops and the view is theirs:
//
//   turn   drag · two-finger scroll · arrow keys · one finger
//   zoom   pinch · mouse wheel · ⌘/Ctrl + scroll · + and −     (toward the pointer)
//   move   W A S D (Shift to go faster) · right-drag · Shift + drag · Shift + scroll · middle-drag · two fingers
//   reset  double-click · 0 · the "Reset view" button           (the sway comes back)
//
// Every move eases, so nothing snaps. The rig is plain numbers and knows
// nothing about the page; `bindCameraInput` is the part that listens.

const DEG = Math.PI / 180;
export const DEFAULT_ELEVATION = 37 * DEG;
const MIN_ELEVATION = 6 * DEG; // never below the table
const MAX_ELEVATION = 86 * DEG; // never quite straight down (the view would flip)
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 6;
const EASE_SECONDS = 0.085;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface CameraPose {
  /** Radians round the world: 0 = from the near side, positive = from the right. */
  azimuth: number;
  /** Radians above the table. */
  elevation: number;
  /** Above 1 is closer than "the whole world fits". */
  zoom: number;
  /** How far the point being looked at has been moved from the middle, in scene units. */
  panX: number;
  panZ: number;
}

const rest = (): CameraPose => ({ azimuth: 0, elevation: DEFAULT_ELEVATION, zoom: 1, panX: 0, panZ: 0 });

export class CameraRig {
  /** Where the camera is heading. */
  private goal = rest();
  /** Where it is now (eases toward the goal). */
  private now = rest();
  private last = 0;
  /** True once someone has taken the camera: the idle sway stays off until reset. */
  held = false;
  /** How far the looked-at point may be moved: half the world's width and depth. */
  private limitX = 5;
  private limitZ = 3.5;
  /** Scene units per screen pixel at the looked-at point (set each frame by the renderer). */
  private unitsPerPixel = 0.01;

  /** The renderer tells the rig about the world and the screen, so pixels turn into the right distances. */
  frameInfo(halfWidth: number, halfDepth: number, unitsPerPixel: number): void {
    this.limitX = halfWidth;
    this.limitZ = halfDepth;
    this.unitsPerPixel = unitsPerPixel;
  }

  /** True when the view is not the resting one (so a "reset" is worth offering). */
  get moved(): boolean {
    return this.held;
  }

  /** Take the camera exactly where it is, so stopping the sway does not jump. */
  grab(): void {
    if (this.held) return;
    this.held = true;
    this.goal.azimuth = this.now.azimuth;
  }

  /** Turn the view as if the world were dragged by this many pixels. */
  orbit(dx: number, dy: number, radiansPerPixel = 0.0045): void {
    this.grab();
    this.goal.azimuth -= dx * radiansPerPixel;
    this.goal.elevation = clamp(this.goal.elevation + dy * radiansPerPixel, MIN_ELEVATION, MAX_ELEVATION);
  }

  /** Slide the view as if the ground were dragged by this many pixels. */
  pan(dx: number, dy: number): void {
    this.grab();
    const { azimuth, elevation } = this.goal;
    const u = this.unitsPerPixel;
    // Screen right, and "away from the camera" along the ground.
    const rx = Math.cos(azimuth), rz = -Math.sin(azimuth);
    const fx = -Math.sin(azimuth), fz = -Math.cos(azimuth);
    const away = (dy * u) / Math.max(0.3, Math.sin(elevation)); // the ground is seen at a slant
    this.goal.panX = clamp(this.goal.panX - rx * dx * u + fx * away, -this.limitX, this.limitX);
    this.goal.panZ = clamp(this.goal.panZ - rz * dx * u + fz * away, -this.limitZ, this.limitZ);
  }

  /** Walk the looked-at point across the ground, in scene units: to the view's right, and away from the camera. */
  walk(right: number, away: number): void {
    this.grab();
    const { azimuth } = this.goal;
    this.goal.panX = clamp(this.goal.panX + Math.cos(azimuth) * right - Math.sin(azimuth) * away, -this.limitX, this.limitX);
    this.goal.panZ = clamp(this.goal.panZ - Math.sin(azimuth) * right - Math.cos(azimuth) * away, -this.limitZ, this.limitZ);
  }

  /**
   * Zoom by a factor (above 1 = closer). With `toward` (a point on the ground,
   * relative to the middle of the world) that point stays under the pointer.
   */
  zoomBy(factor: number, toward?: { x: number; z: number }): void {
    this.grab();
    const next = clamp(this.goal.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const real = next / this.goal.zoom;
    this.goal.zoom = next;
    if (toward && real !== 1) {
      const keep = 1 - 1 / real;
      this.goal.panX = clamp(this.goal.panX + (toward.x - this.goal.panX) * keep, -this.limitX, this.limitX);
      this.goal.panZ = clamp(this.goal.panZ + (toward.z - this.goal.panZ) * keep, -this.limitZ, this.limitZ);
    }
  }

  /** Back to the resting view, the short way round. The sway resumes. */
  reset(): void {
    this.held = false;
    this.goal = rest();
    // However many times it was turned, come back by the nearest route.
    this.now.azimuth = Math.atan2(Math.sin(this.now.azimuth), Math.cos(this.now.azimuth));
  }

  /**
   * Ease toward the goal and return where the camera is.
   * @param sway  the idle sway's angle right now (ignored once the camera is held)
   * @param time  a clock in seconds (real time, so the camera moves even when the world's time is frozen)
   */
  step(sway: number, time: number): CameraPose {
    const dt = clamp(time - this.last, 0, 0.1);
    this.last = time;
    if (!this.held) this.goal.azimuth = sway;
    const k = 1 - Math.exp(-dt / EASE_SECONDS);
    const { now, goal } = this;
    for (const key of ['azimuth', 'elevation', 'zoom', 'panX', 'panZ'] as const) {
      // Close enough is there: an untouched camera sits exactly on its goal.
      now[key] = Math.abs(goal[key] - now[key]) < 1e-5 ? goal[key] : now[key] + (goal[key] - now[key]) * k;
    }
    return now;
  }

  /** Put the camera at a fixed angle at once, in degrees (the harness uses this to look from the side). */
  lookFrom(azimuthDeg: number, elevationDeg: number): void {
    this.held = true;
    this.goal.azimuth = azimuthDeg * DEG;
    this.goal.elevation = clamp(elevationDeg * DEG, MIN_ELEVATION, MAX_ELEVATION);
    this.settle();
  }

  /** Jump straight to the goal (no easing). */
  settle(): void {
    Object.assign(this.now, this.goal);
  }

  get target(): Readonly<CameraPose> {
    return this.goal;
  }
}

// --- walking the view with W A S D ------------------------------------------------------

export const MOVE_KEYS = ['w', 'a', 's', 'd'] as const;
const WALK = 3.2; // scene units a second at the usual zoom (the world is 10 wide): about three seconds to cross
const RUN = 9; // with Shift held

/**
 * Move the view for the keys held down: W away, S toward you, A left, D right,
 * faster with Shift. Call every frame; the speed is the same at any frame rate,
 * and slower when zoomed in, so it always feels the same on screen.
 */
export function moveWithKeys(rig: CameraRig, held: ReadonlySet<string>, fast: boolean, dt: number): void {
  const right = (held.has('d') ? 1 : 0) - (held.has('a') ? 1 : 0);
  const away = (held.has('w') ? 1 : 0) - (held.has('s') ? 1 : 0);
  if (!right && !away) return;
  // Diagonals are no faster than straight lines.
  const step = ((fast ? RUN : WALK) * dt) / (Math.hypot(right, away) * rig.target.zoom);
  rig.walk(right * step, away * step);
}

// --- listening to the mouse, trackpad, fingers ---------------------------------------

export interface CameraInputHost {
  rig: CameraRig;
  /** The ground point under a screen position, relative to the middle of the world. */
  groundPoint(clientX: number, clientY: number): { x: number; z: number } | null;
}

/**
 * Is this wheel event a mouse wheel (zoom) or two fingers on a trackpad (turn)?
 * Decided once at the start of each burst of events and kept until it ends, so a
 * fast flick is never mistaken halfway through. A trackpad starts with small
 * moves; a notched wheel starts with a big step, or reports whole lines.
 */
function wheelKind(e: WheelEvent, state: { kind: 'mouse' | 'trackpad'; at: number }): 'mouse' | 'trackpad' {
  if (e.timeStamp - state.at > 180) {
    state.kind = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50) ? 'mouse' : 'trackpad';
  }
  state.at = e.timeStamp;
  return state.kind;
}

/**
 * Make a canvas move the camera. `blocked` says when a press belongs to
 * something else (a card being picked up), so the camera leaves it alone.
 * Returns a function that removes the listeners.
 */
export function bindCameraInput(canvas: HTMLElement, host: CameraInputHost, blocked: () => boolean = () => false): () => void {
  const { rig } = host;
  const pointers = new Map<number, { x: number; y: number }>();
  let mode: 'orbit' | 'pan' | null = null;
  let pinch = 0; // distance between two fingers at the last move
  let ownsPress = false;
  const wheel = { kind: 'trackpad' as 'mouse' | 'trackpad', at: -Infinity };
  const off = new AbortController();
  const on = <K extends keyof HTMLElementEventMap>(type: K, handler: (e: HTMLElementEventMap[K]) => void, passive = true) =>
    canvas.addEventListener(type, handler as EventListener, { signal: off.signal, passive });

  const centre = () => {
    let x = 0, y = 0;
    for (const p of pointers.values()) x += p.x, y += p.y;
    return { x: x / pointers.size, y: y / pointers.size };
  };
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  on('pointerdown', (e) => {
    ownsPress = !blocked();
    if (!ownsPress) return;
    rig.grab(); // a click alone is enough to stop the sway
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) pinch = spread();
    mode = e.pointerType === 'mouse' && (e.button !== 0 || e.shiftKey) ? 'pan' : 'orbit';
    canvas.style.cursor = 'grabbing';
    try {
      canvas.setPointerCapture(e.pointerId); // keep the drag when the pointer leaves the picture
    } catch {
      /* a pointer the browser no longer knows: the drag still works while it stays over the picture */
    }
  });
  on('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size === 1) {
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (mode === 'pan') rig.pan(dx, dy);
      else rig.orbit(dx, dy);
      p.x = e.clientX, p.y = e.clientY;
    } else if (pointers.size === 2) {
      // Two fingers: slide to move, spread or pinch to zoom.
      const before = centre();
      p.x = e.clientX, p.y = e.clientY;
      const after = centre();
      rig.pan(after.x - before.x, after.y - before.y);
      const now = spread();
      if (pinch > 0 && now > 0) rig.zoomBy(now / pinch, host.groundPoint(after.x, after.y) ?? undefined);
      pinch = now;
    }
  });
  const release = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size < 2) pinch = 0;
    if (pointers.size === 0) {
      mode = null;
      canvas.style.cursor = '';
    }
  };
  on('pointerup', release);
  on('pointercancel', release);
  on('contextmenu', (e) => e.preventDefault(), false); // right-drag moves the view
  on('dblclick', () => {
    if (ownsPress) rig.reset();
  });

  on('wheel', (e) => {
    e.preventDefault(); // no page zoom, no swipe-back
    if (e.ctrlKey || e.metaKey) {
      // A pinch on a trackpad arrives as Ctrl + wheel; so does a deliberate Ctrl/⌘ + scroll.
      rig.zoomBy(Math.exp(-clamp(e.deltaY, -60, 60) * 0.012), host.groundPoint(e.clientX, e.clientY) ?? undefined);
    } else if (wheelKind(e, wheel) === 'mouse') {
      const step = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 300 : e.deltaY;
      rig.zoomBy(Math.exp(-clamp(step, -300, 300) * 0.0018), host.groundPoint(e.clientX, e.clientY) ?? undefined);
    } else if (e.shiftKey) {
      rig.pan(-e.deltaX, -e.deltaY);
    } else {
      // Two fingers move the world the way they would move a page.
      rig.orbit(-e.deltaX, -e.deltaY, 0.0032);
    }
  }, false);

  // Safari on a Mac reports a pinch as its own kind of event.
  let lastScale = 1;
  const gesture = (type: string, handler: (e: Event & { scale: number; clientX: number; clientY: number }) => void) =>
    canvas.addEventListener(type, handler as EventListener, { signal: off.signal });
  gesture('gesturestart', (e) => {
    e.preventDefault();
    lastScale = 1;
  });
  gesture('gesturechange', (e) => {
    e.preventDefault();
    if (e.scale > 0) rig.zoomBy(e.scale / lastScale, host.groundPoint(e.clientX, e.clientY) ?? undefined);
    lastScale = e.scale || 1;
  });

  return () => off.abort();
}

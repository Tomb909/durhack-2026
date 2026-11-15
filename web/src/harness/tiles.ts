// Draws one settled world into a picture. Shared by the sheet page
// (/harness.html) and the Combinations view in the app, so both always show
// the same thing. One 3D renderer serves every tile: the shaders compile once.
import { WorldRenderer } from '../render/scene';
import { placeProps } from '../sim/props';
import { GH, GW, WorldSim } from '../sim/world';
import type { Placement } from './codes';
import { biomesOf, drawCardMarks, drawMap, drawObjectMarks } from './map';
import { liveCards, measure, type Metrics } from './metrics';

/** 3d: the world as the app shows it. map: flat and top-down, no GPU. both: 3D with a small map in the corner. */
export type View = '3d' | 'map' | 'both';
export const VIEWS: View[] = ['3d', 'map', 'both'];

export interface TileOptions {
  width: number;
  height: number;
  view: View;
  /** The moment drawn, in seconds: rain and waves are stopped there. */
  time: number;
  /** Above 1 moves the camera closer than the app does. */
  zoom: number;
  /** Pillars of light where the cards are. */
  beacons: boolean;
  /** Where the camera looks from, in degrees: round the world (0 = the near side) and above the table (the app's usual is 37). */
  azimuth?: number;
  elevation?: number;
}

/** A tile's height for its width: the map keeps the table's shape, 3D is 16:10. */
export function tileHeight(width: number, view: View): number {
  return view === 'map' ? Math.round((width * GH) / GW) : Math.round(width * 0.625);
}

export class TileRenderer {
  private sim = new WorldSim();
  private renderer: WorldRenderer | null = null;
  private gl: HTMLCanvasElement | null = null;
  private map = document.createElement('canvas');
  private drawn = 0;
  /** Milliseconds spent creating the 3D renderer (once). */
  setupMs = 0;

  get gpuName(): string {
    return this.renderer?.gpuName ?? 'none (map only)';
  }

  private renderer3d(width: number, height: number): { renderer: WorldRenderer; gl: HTMLCanvasElement } {
    if (!this.renderer || !this.gl) {
      const t0 = performance.now();
      this.gl = document.createElement('canvas');
      this.gl.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden';
      this.gl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(this.gl);
      // The app's card labels are page elements, not part of the picture, so they cannot be
      // copied into a tile: give them a layer that is never shown. Captions name the cards instead.
      this.renderer = new WorldRenderer(this.gl, document.createElement('div'));
      this.renderer.sway = false;
      this.setupMs += performance.now() - t0;
    }
    if (this.gl.width !== width || this.gl.height !== height) {
      this.gl.style.width = `${width}px`;
      this.gl.style.height = `${height}px`;
      this.renderer.setFixedSize(width, height);
    }
    return { renderer: this.renderer, gl: this.gl };
  }

  /** Settle these cards and draw the world into `g` at x,y. Returns its numbers and how long each part took. */
  draw(g: CanvasRenderingContext2D, x: number, y: number, cards: Placement[], o: TileOptions): { metrics: Metrics; simMs: number; drawMs: number } {
    let t0 = performance.now();
    // A fresh key per tile: the renderer keeps a pillar per card key, coloured when first made.
    const live = liveCards(cards, `tile${this.drawn++}`);
    const frame = this.sim.settleNow(live);
    const objects = placeProps(frame, live);
    const metrics = measure(frame, live, objects);
    const simMs = performance.now() - t0;

    t0 = performance.now();
    if (o.view !== 'map') {
      const { renderer, gl } = this.renderer3d(o.width, o.height);
      renderer.showBeacons = o.beacons;
      renderer.zoom = o.zoom;
      if (o.azimuth !== undefined || o.elevation !== undefined) renderer.rig.lookFrom(o.azimuth ?? 0, o.elevation ?? 37);
      renderer.renderAt(frame, live, o.time);
      g.drawImage(gl, x, y, o.width, o.height);
    }
    if (o.view !== '3d') {
      drawMap(frame, this.map, biomesOf(cards));
      // Alone: the whole tile. With 3D: a small inset in the corner.
      const w = o.view === 'map' ? o.width : Math.round(o.width * 0.3);
      const h = o.view === 'map' ? o.height : Math.round((w * GH) / GW);
      const mx = o.view === 'map' ? x : x + 4;
      const my = o.view === 'map' ? y : y + o.height - h - 4;
      g.imageSmoothingEnabled = w < GW;
      g.drawImage(this.map, mx, my, w, h);
      g.imageSmoothingEnabled = true;
      if (o.view === 'both') {
        g.strokeStyle = 'rgba(255,255,255,0.7)';
        g.lineWidth = 1;
        g.strokeRect(mx - 0.5, my - 0.5, w + 1, h + 1);
      }
      drawObjectMarks(g, objects, mx, my, w, h);
      drawCardMarks(g, cards, mx, my, w, h);
    }
    return { metrics, simMs, drawMs: performance.now() - t0 };
  }
}

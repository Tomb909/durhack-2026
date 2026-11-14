// Water on land, by "priority flood": start at every outlet (the sea and the
// edge of the world) and climb inland from the lowest point reached so far.
// One pass tells us, for every cell, the level a hollow would fill to before
// spilling, and which neighbour its water drains to. Sending rain down those
// drains gives rivers; hollows that receive enough flow become lakes.

const EPS = 1e-5;
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

export interface HydrologyRules {
  /** Flow needed before a river starts to show, and to show fully. */
  riverStart: number;
  riverFull: number;
  /** Flow into a hollow needed before a lake starts to fill, and fills. */
  lakeStart: number;
  lakeFull: number;
  /** Hollows shallower than this are ignored. */
  lakeMinDepth: number;
  riverDepth: number;
  /** Dry land keeps its water surface this far under the ground. */
  dryOffset: number;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Hydrology {
  readonly n: number;
  private filled: Float32Array;
  private parent: Int32Array;
  private order: Int32Array;
  private visited: Uint8Array;
  private flow: Float32Array;
  private lakeFlow: Float32Array;
  private heapCell: Int32Array;
  private heapLevel: Float32Array;
  private heapSize = 0;
  private scratch: Float32Array;

  constructor(readonly w: number, readonly h: number) {
    this.n = w * h;
    this.filled = new Float32Array(this.n);
    this.parent = new Int32Array(this.n);
    this.order = new Int32Array(this.n);
    this.visited = new Uint8Array(this.n);
    this.flow = new Float32Array(this.n);
    this.lakeFlow = new Float32Array(this.n);
    this.heapCell = new Int32Array(this.n);
    this.heapLevel = new Float32Array(this.n);
    this.scratch = new Float32Array(this.n);
  }

  private push(cell: number, level: number): void {
    let i = this.heapSize++;
    const cells = this.heapCell;
    const levels = this.heapLevel;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (levels[up] <= level) break;
      cells[i] = cells[up];
      levels[i] = levels[up];
      i = up;
    }
    cells[i] = cell;
    levels[i] = level;
  }

  private pop(): number {
    const cells = this.heapCell;
    const levels = this.heapLevel;
    const top = cells[0];
    const size = --this.heapSize;
    if (size > 0) {
      const cell = cells[size];
      const level = levels[size];
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= size) break;
        if (child + 1 < size && levels[child + 1] < levels[child]) child++;
        if (levels[child] >= level) break;
        cells[i] = cells[child];
        levels[i] = levels[child];
        i = child;
      }
      cells[i] = cell;
      levels[i] = level;
    }
    return top;
  }

  /**
   * @param height   land height per cell
   * @param sea      sea level
   * @param rain     rainfall per cell (0..1)
   * @param surface  out: water surface height (just under the ground where dry)
   * @param river    out: river strength 0..1
   */
  compute(
    height: Float32Array, sea: number, rain: Float32Array,
    surface: Float32Array, river: Float32Array, rules: HydrologyRules,
  ): void {
    const { w, h, n, filled, parent, order, visited, flow, lakeFlow } = this;
    visited.fill(0);
    this.heapSize = 0;

    // Outlets: every sea cell and every cell on the edge of the world.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
        if (edge || height[i] < sea) {
          filled[i] = Math.max(height[i], sea);
          parent[i] = -1;
          visited[i] = 1;
          this.push(i, filled[i]);
        }
      }
    }

    let count = 0;
    while (this.heapSize > 0) {
      const c = this.pop();
      order[count++] = c;
      const cx = c % w;
      const cy = (c - cx) / w;
      const level = filled[c] + EPS;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k];
        const ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (visited[ni]) continue;
        visited[ni] = 1;
        const f = height[ni] > level ? height[ni] : level;
        filled[ni] = f;
        parent[ni] = c;
        this.push(ni, f);
      }
    }

    // Rain runs downhill: add each cell's flow to the cell it drains to.
    for (let i = 0; i < n; i++) flow[i] = rain[i];
    for (let k = count - 1; k >= 0; k--) {
      const c = order[k];
      const p = parent[c];
      if (p >= 0) flow[p] += flow[c];
    }

    // Every cell of a hollow shares the flow leaving at its spill point.
    const raw = this.scratch;
    for (let k = 0; k < count; k++) {
      const c = order[k];
      const depth = filled[c] - height[c];
      const isSea = height[c] < sea;
      if (isSea) {
        lakeFlow[c] = 0;
        surface[c] = sea;
        raw[c] = 0;
        continue;
      }
      if (depth > rules.lakeMinDepth) {
        const p = parent[c];
        const upstream = p >= 0 ? lakeFlow[p] : 0;
        lakeFlow[c] = flow[c] > upstream ? flow[c] : upstream;
        const full = smoothstep(rules.lakeStart, rules.lakeFull, lakeFlow[c]);
        surface[c] = height[c] + depth * full - rules.dryOffset * (1 - full);
        raw[c] = 0;
      } else {
        lakeFlow[c] = 0;
        const r = smoothstep(rules.riverStart, rules.riverFull, flow[c]);
        raw[c] = r;
        surface[c] = height[c] + rules.riverDepth * r - rules.dryOffset * (1 - r);
      }
    }

    // Soften rivers a little so they are not one jagged cell wide.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const l = x > 0 ? raw[i - 1] : raw[i];
        const r = x < w - 1 ? raw[i + 1] : raw[i];
        const u = y > 0 ? raw[i - w] : raw[i];
        const d = y < h - 1 ? raw[i + w] : raw[i];
        river[i] = Math.max(raw[i], 0.45 * Math.max(l, r, u, d));
      }
    }
    for (let i = 0; i < n; i++) {
      if (raw[i] === 0 && river[i] > 0 && height[i] >= sea && filled[i] - height[i] <= rules.lakeMinDepth) {
        const r = river[i];
        surface[i] = height[i] + rules.riverDepth * r - rules.dryOffset * (1 - r);
      }
    }
  }
}

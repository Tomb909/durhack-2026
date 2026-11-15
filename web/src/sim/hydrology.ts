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
  /** Share of the flow that carries on to the next cell (default 1: all of it). Below 1 a stream thins out and stops. */
  keep?: number;
  /**
   * True: a hollow that is only part full has a level surface part way up, as a real lake does.
   * False (default): every cell of the hollow is covered, by the same share of its depth.
   */
  levelLakes?: boolean;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Hydrology {
  readonly n: number;
  /** After flood(): the level each cell's hollow fills to before it spills. */
  filled: Float32Array;
  /** After flood(): the cell each cell drains to, or -1 at an outlet. */
  parent: Int32Array;
  private fillFlow: Float32Array;
  private order: Int32Array;
  private visited: Uint8Array;
  private flow: Float32Array;
  private lakeFlow: Float32Array;
  private heapCell: Int32Array;
  private heapLevel: Float32Array;
  private heapSize = 0;
  private scratch: Float32Array;
  /** What the last climb inland was worked out for, and how many cells it reached (-1: never yet). */
  private land: Float32Array;
  private landSea = Number.NaN;
  private landHole = Number.NaN;
  private landInside: Uint8Array | null = null;
  private count = -1;
  private seaCell: Uint8Array;
  private stack: Int32Array;
  private basin: Int32Array;
  private basinLow: Float32Array;

  constructor(readonly w: number, readonly h: number) {
    this.n = w * h;
    this.filled = new Float32Array(this.n);
    this.parent = new Int32Array(this.n);
    this.order = new Int32Array(this.n);
    this.visited = new Uint8Array(this.n);
    this.flow = new Float32Array(this.n);
    this.lakeFlow = new Float32Array(this.n);
    this.fillFlow = new Float32Array(this.n);
    this.heapCell = new Int32Array(this.n);
    this.heapLevel = new Float32Array(this.n);
    this.scratch = new Float32Array(this.n);
    this.land = new Float32Array(this.n);
    this.seaCell = new Uint8Array(this.n);
    this.stack = new Int32Array(this.n);
    this.basin = new Int32Array(this.n);
    this.basinLow = new Float32Array(this.n);
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
   * Where the sea lies, and the climb inland from every outlet: fills `seaCell`, `filled`
   * (the level each cell would flood to), `parent` (the cell it drains to) and `order`
   * (cells from the outlets upward). All of it follows from the land, the sea level, the
   * play area and `holeBelow` alone, which is what lets `compute` keep it between calls.
   * Also called by itself (RIVER cards find their way with it): `filled` and `parent` are then read directly.
   */
  flood(height: Float32Array, sea: number, inside: Uint8Array | null = null, holeBelow = -Infinity): void {
    const { w, h, n, filled, parent, order, visited, seaCell, stack } = this;
    visited.fill(0);
    this.heapSize = 0;
    if (inside) {
      for (let i = 0; i < n; i++) {
        if (inside[i]) continue;
        visited[i] = 1;
        filled[i] = height[i];
        parent[i] = -1;
      }
    }

    // Where the sea is: all ground under sea level that is not a hole, and any hole it can pour into.
    seaCell.fill(0);
    let top = 0;
    for (let i = 0; i < n; i++) {
      if ((inside && !inside[i]) || height[i] >= sea || height[i] < holeBelow) continue;
      seaCell[i] = 1;
      stack[top++] = i;
    }
    while (top > 0) {
      const c = stack[--top];
      const cx = c % w;
      const cy = (c - cx) / w;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k];
        const ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (seaCell[ni] || height[ni] >= sea || (inside && !inside[ni])) continue;
        seaCell[ni] = 1;
        stack[top++] = ni;
      }
    }

    // Outlets: every sea cell and every cell on the edge of the world (or of the shape).
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (inside && !inside[i]) continue;
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          (inside != null && (!inside[i - 1] || !inside[i + 1] || !inside[i - w] || !inside[i + w]));
        if (edge || seaCell[i]) {
          filled[i] = seaCell[i] ? sea : height[i];
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
    this.count = count;
    this.land.set(height);
    this.landSea = sea;
    this.landHole = holeBelow;
    this.landInside = inside;
  }

  /** True when the land, the sea, the play area and the hole rule are exactly as they were for the last climb. */
  private sameLand(height: Float32Array, sea: number, inside: Uint8Array | null, holeBelow: number): boolean {
    if (this.count < 0 || sea !== this.landSea || holeBelow !== this.landHole || inside !== this.landInside) return false;
    const land = this.land;
    for (let i = 0; i < this.n; i++) if (height[i] !== land[i]) return false;
    return true;
  }

  /**
   * @param height   land height per cell
   * @param sea      sea level
   * @param rain     rainfall per cell (0..1)
   * @param surface  out: water surface height (just under the ground where dry)
   * @param river    out: river strength 0..1
   * @param inside   optional: 1 for cells inside the play area. Outside cells stay dry
   *                 and the inside cells along the shape's edge drain off the world.
   * @param holeBelow optional: ground lower than this is a dug hole. The sea does not well
   *                 up inside a hole: it has to pour in from flooded ground beside it.
   *                 Until then the hole is dry, or a lake if enough rain runs into it.
   * @param spring   optional: water welling up per cell, in units of flow. It fills the
   *                 hollows it runs into (LAKE, RIVER) but draws no river of its own.
   * @param course   optional: 0..1 river strength laid down per cell (a RIVER card's bed).
   */
  compute(
    height: Float32Array, sea: number, rain: Float32Array,
    surface: Float32Array, river: Float32Array, rules: HydrologyRules,
    inside?: Uint8Array | null,
    holeBelow = -Infinity,
    spring?: Float32Array | null, course?: Float32Array | null,
  ): void {
    const { w, h, n, filled, parent, order, flow, lakeFlow, fillFlow, seaCell } = this;
    const raw = this.scratch;
    raw.fill(0);
    // Which way water drains depends only on the land and the sea. While those stand still
    // (a card that does not move the ground is being moved; the water is settling) the
    // climb inland, the costly part, gives the same answer as last time: keep it.
    if (!this.sameLand(height, sea, inside ?? null, holeBelow)) this.flood(height, sea, inside ?? null, holeBelow);
    const count = this.count;

    // Rain runs downhill: add each cell's flow to the cell it drains to.
    const keep = rules.keep ?? 1;
    for (let i = 0; i < n; i++) {
      flow[i] = rain[i];
      fillFlow[i] = spring ? spring[i] : 0;
    }
    for (let k = count - 1; k >= 0; k--) {
      const c = order[k];
      const p = parent[c];
      if (p >= 0) {
        flow[p] += flow[c] * keep;
        fillFlow[p] += fillFlow[c] * keep;
      }
    }

    // Every cell of a hollow shares the flow leaving at its spill point.
    const { basin, basinLow } = this;
    const level = rules.levelLakes === true;
    for (let k = 0; k < count; k++) {
      const c = order[k];
      const depth = filled[c] - height[c];
      basin[c] = -1;
      if (seaCell[c]) {
        lakeFlow[c] = 0;
        surface[c] = sea;
        raw[c] = 0;
        continue;
      }
      if (depth > rules.lakeMinDepth) {
        const p = parent[c];
        const upstream = p >= 0 ? lakeFlow[p] : 0;
        const here = flow[c] + fillFlow[c];
        lakeFlow[c] = here > upstream ? here : upstream;
        const full = smoothstep(rules.lakeStart, rules.lakeFull, lakeFlow[c]);
        surface[c] = height[c] + depth * full - rules.dryOffset * (1 - full);
        raw[c] = 0;
        if (level) {
          // The hollow this cell belongs to is named after its first cell (the one by the spill point).
          const root = p >= 0 && basin[p] >= 0 ? basin[p] : c;
          basin[c] = root;
          if (root === c || height[c] < basinLow[root]) basinLow[root] = height[c];
        }
      } else {
        lakeFlow[c] = 0;
        let r = smoothstep(rules.riverStart, rules.riverFull, flow[c]);
        if (course && course[c] > r) r = course[c];
        raw[c] = r;
        surface[c] = height[c] + rules.riverDepth * r - rules.dryOffset * (1 - r);
      }
    }

    // Level lakes: one flat surface per hollow, part way between its lowest point and its spill point.
    if (level) {
      for (let k = 0; k < count; k++) {
        const c = order[k];
        const root = basin[c];
        if (root < 0) continue;
        const full = smoothstep(rules.lakeStart, rules.lakeFull, lakeFlow[root]);
        const at = basinLow[root] + (filled[root] - basinLow[root]) * full;
        surface[c] = full > 0 && height[c] < at ? at : height[c] - rules.dryOffset;
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
        river[i] = Math.max(raw[i], 0.7 * Math.max(l, r, u, d));
      }
    }
    if (inside) {
      for (let i = 0; i < n; i++) {
        if (inside[i]) continue;
        river[i] = 0;
        surface[i] = height[i] - rules.dryOffset;
      }
    }
    for (let i = 0; i < n; i++) {
      if (raw[i] === 0 && river[i] > 0 && (!inside || inside[i]) && !seaCell[i] && filled[i] - height[i] <= rules.lakeMinDepth) {
        const r = river[i];
        surface[i] = height[i] + rules.riverDepth * r - rules.dryOffset * (1 - r);
      }
    }
  }
}

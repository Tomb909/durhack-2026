"""Find word-sized clusters of marker ink in the rectified (top-down) image.

We look for ink, not paper: thin dark strokes whose surroundings are light.
That works for white scraps on a white sheet, and it ignores hands, sleeves
and shadows because those are not thin strokes.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from . import PX_PER_MM, mm, odd

BACKGROUND_MM = 18.0  # the paper level is the median over a window this wide
INK_RATIO = 0.66  # a stroke pixel is darker than this fraction of its surroundings...
INK_CORE_RATIO = 0.50  # ...and the stroke must somewhere be this dark. Pen strokes measure 0.25-0.4;
# the shadow under a scrap's torn edge about 0.6, so it is dropped.
PAPER_MIN_LEVEL = 25  # surroundings darker than this are not paper at all
# What counts as something lying over the paper (a hand, a sleeve) rather than a shadow.
# A shadow only dims white paper: it stays colourless and rarely drops below a third of
# the lit level. Skin and most clothing are coloured; black things are far darker.
OCCLUDER_CHROMA = 10.0  # colour difference from the paper (Lab units); paper in shadow measures under 5
OCCLUDER_DARK = 0.18  # darker than this fraction of the lit paper = a black object
OCCLUDER_DROP = 0.70  # dimmer than this fraction of its own usual level = something new is over it
OCCLUDER_MIN_MM = 8.0  # anything thinner than this is a pen stroke, not an object
BACKDROP_BRIGHTEN_SECONDS = 0.5  # the usual level recovers quickly when things clear
BACKDROP_DARKEN_SECONDS = 6.0  # ...and accepts a lasting shadow slowly
EDGE_MARGIN_MM = 5.0
LETTER_JOIN_MM = 2.5  # closes breaks inside a single letter
# Letters join into a word in two steps: first anything nearly touching, then
# along the line of writing only, so words on scraps stacked close together
# stay separate even when the lines are nearer than the letters are tall.
TOUCH_FACTOR = 0.35  # step 1: gap under this many letter-heights...
TOUCH_MM = (3.5, 8.0)  # ...kept within these limits
LINE_FACTOR = 1.5  # step 2: gap along the line under this many letter-heights...
LINE_MM = (6.0, 18.0)  # ...kept within these limits
LINE_OFFSET = 0.8  # ...and no further off the line than this many letter-heights
LOOSE_FACTOR = 0.85  # two lone letters with no line yet
LOOSE_MM = (4.0, 14.0)
WORD_LONG_MM = (14.0, 190.0)
WORD_SHORT_MM = (5.0, 75.0)
MIN_INK_MM2 = 18.0
MIN_LETTER_MM2 = 1.5
MAX_LETTERS = 300
TRACE: list | None = None  # set to a list to record every join decision (debugging)


@dataclass
class Detection:
    x: float  # centre, rectified pixels
    y: float
    angle: float  # degrees, direction of the word's long axis
    long: float  # rectified pixels
    short: float
    ink: float  # ink area in mm^2

    @property
    def box(self) -> np.ndarray:
        """Four corners of the word's rotated box, rectified pixels."""
        return cv2.boxPoints(((self.x, self.y), (self.long, self.short), self.angle))


@dataclass
class DetectResult:
    detections: list[Detection]
    ink: np.ndarray  # uint8 mask of ink pixels
    occluder: np.ndarray  # uint8 mask of things covering the paper (hands, sleeves)


def _paper_level(gray: np.ndarray) -> np.ndarray:
    """Local brightness of the surface, ignoring thin strokes.

    A median (not a maximum) is used so that the edge of a shadow stays on its
    own side: a hard shadow line must not look like a band of ink.
    """
    h, w = gray.shape
    small = cv2.resize(gray, (w // 4, h // 4), interpolation=cv2.INTER_AREA)
    k = odd(max(3, mm(BACKGROUND_MM) // 4))
    small = cv2.medianBlur(small, k)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)


class Backdrop:
    """Remembers how bright each part of the sheet usually is.

    A hand or sleeve arriving makes a patch suddenly dimmer than usual, which
    is how grey, colourless things are noticed. A shadow that stays put becomes
    the usual level within a few seconds and is then ignored.
    """

    def __init__(self) -> None:
        self.level: np.ndarray | None = None
        self.time = 0.0

    def reset(self) -> None:
        self.level = None

    def update(self, paper: np.ndarray, now: float) -> np.ndarray:
        """Returns a mask of places that are much dimmer than usual."""
        current = paper.astype(np.float32)
        if self.level is None or self.level.shape != current.shape:
            self.level = current.copy()
            self.time = now
            return np.zeros(paper.shape, np.uint8)
        dt = float(np.clip(now - self.time, 0.0, 1.0))
        self.time = now
        dimmer = (current < OCCLUDER_DROP * self.level).astype(np.uint8) * 255
        up = 1.0 - np.exp(-dt / BACKDROP_BRIGHTEN_SECONDS)
        down = 1.0 - np.exp(-dt / BACKDROP_DARKEN_SECONDS)
        self.level += np.where(current > self.level, up, down) * (current - self.level)
        return dimmer


class _Fragment:
    """A growing group of letters, with enough statistics to know its line of writing."""

    __slots__ = ("letters", "n", "sx", "sy", "sxx", "sxy", "syy", "size_sum")

    def __init__(self, index: int, points: np.ndarray, size: float) -> None:
        self.letters = [index]
        x, y = points[:, 0].astype(np.float64), points[:, 1].astype(np.float64)
        self.n = float(len(x))
        self.sx, self.sy = float(x.sum()), float(y.sum())
        self.sxx, self.sxy, self.syy = float((x * x).sum()), float((x * y).sum()), float((y * y).sum())
        self.size_sum = size

    def absorb(self, other: "_Fragment") -> None:
        self.letters += other.letters
        self.n += other.n
        self.sx += other.sx
        self.sy += other.sy
        self.sxx += other.sxx
        self.sxy += other.sxy
        self.syy += other.syy
        self.size_sum += other.size_sum

    @property
    def centre(self) -> tuple[float, float]:
        return self.sx / self.n, self.sy / self.n

    def line(self) -> tuple[bool, float, float, float]:
        """(has a clear line of writing, direction x, direction y, letter height in px)."""
        cx, cy = self.centre
        a = self.sxx / self.n - cx * cx
        b = self.sxy / self.n - cx * cy
        c = self.syy / self.n - cy * cy
        root = float(np.sqrt(max(0.0, (a - c) ** 2 / 4.0 + b * b)))
        major, minor = (a + c) / 2.0 + root, max(1e-6, (a + c) / 2.0 - root)
        angle = 0.5 * float(np.arctan2(2.0 * b, a - c))
        across = 3.46 * float(np.sqrt(minor))  # full extent across the line, for a filled band
        along = 3.46 * float(np.sqrt(major))
        mean_size = self.size_sum / len(self.letters)
        if len(self.letters) >= 2:
            # Several pieces only show a line of writing once they span more than
            # one letter: the strokes of a single broken letter must not count.
            has = major > 2.5 * minor and across >= 4.0 * PX_PER_MM and along >= 1.5 * mean_size
        else:
            # A single blob only has a line if it is a whole joined-up word, not one stroke.
            # A tall narrow letter (L, F, E) is also elongated, so it must be longer than any letter.
            has = major > 9.0 * minor and across >= 5.0 * PX_PER_MM and along >= 28.0 * PX_PER_MM
        if has:
            height = float(np.clip(across, 5.0 * PX_PER_MM, 40.0 * PX_PER_MM))
        else:
            height = float(max(mean_size, min(along, 40.0 * PX_PER_MM)))
        return has, float(np.cos(angle)), float(np.sin(angle)), height


def _limit(factor: float, size: float, limits_mm: tuple[float, float]) -> float:
    return float(np.clip(factor * size, limits_mm[0] * PX_PER_MM, limits_mm[1] * PX_PER_MM))


def _group_letters(ink: np.ndarray) -> list[np.ndarray]:
    """Group ink blobs (letters) into words. Returns one point array per word."""
    k = odd(mm(LETTER_JOIN_MM))
    joined = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(joined, connectivity=8)
    min_area = MIN_LETTER_MM2 * PX_PER_MM * PX_PER_MM
    order = [i for i in range(1, count) if stats[i, cv2.CC_STAT_AREA] >= min_area]
    order.sort(key=lambda i: -int(stats[i, cv2.CC_STAT_AREA]))
    points: list[np.ndarray] = []
    boxes: list[tuple[float, float, float, float]] = []
    for i in order[:MAX_LETTERS]:
        x0, y0, bw, bh = (int(v) for v in stats[i, :4])
        ys, xs = np.nonzero((labels[y0 : y0 + bh, x0 : x0 + bw] == i) & (ink[y0 : y0 + bh, x0 : x0 + bw] > 0))
        if len(xs) == 0:
            continue
        points.append(np.column_stack((xs + x0, ys + y0)).astype(np.float32))
        boxes.append((x0, y0, x0 + bw, y0 + bh))
    n = len(points)
    if n == 0:
        return []
    box = np.array(boxes, dtype=np.float32)
    sizes = np.maximum(box[:, 2] - box[:, 0], box[:, 3] - box[:, 1])

    # Gaps between every pair of letters (between their bounding boxes).
    dx = np.maximum(0, np.maximum(box[:, None, 0] - box[None, :, 2], box[None, :, 0] - box[:, None, 2]))
    dy = np.maximum(0, np.maximum(box[:, None, 1] - box[None, :, 3], box[None, :, 1] - box[:, None, 3]))
    gap = np.hypot(dx, dy)
    ii, jj = np.nonzero(np.triu(gap <= LINE_MM[1] * PX_PER_MM, k=1))
    # Boxes of tilted words overlap even when the ink is well apart, so measure
    # the real ink-to-ink distance for every pair that might be close.
    sample = [pts[:: max(1, len(pts) // 90)] for pts in points]
    edges = []
    for i, j in zip(ii.tolist(), jj.tolist()):
        a, b = sample[i], sample[j]
        d = np.sqrt(((a[:, None, :] - b[None, :, :]) ** 2).sum(axis=2).min())
        if d <= LINE_MM[1] * PX_PER_MM:
            edges.append((float(d), i, j))
    edges.sort()

    parent = list(range(n))
    fragments: dict[int, _Fragment] = {i: _Fragment(i, points[i], float(sizes[i])) for i in range(n)}
    # A blob that is a whole joined-up word must be judged by its letter height, not its length.
    for i, fragment in fragments.items():
        sizes[i] = fragment.size_sum = fragment.line()[3]

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a: int, b: int) -> None:
        if len(fragments[a].letters) < len(fragments[b].letters):
            a, b = b, a
        fragments[a].absorb(fragments.pop(b))
        parent[b] = a

    # Step 1: letters that nearly touch always belong together.
    for g, i, j in edges:
        if g > _limit(TOUCH_FACTOR, float(min(sizes[i], sizes[j])), TOUCH_MM):
            continue
        a, b = root(i), root(j)
        if a != b:
            union(a, b)

    # Step 2: extend along each line of writing. Twice, because joining letters
    # reveals lines that allow further joins.
    for _ in range(3):
        for g, i, j in edges:
            a, b = root(i), root(j)
            if a == b:
                continue
            fa, fb = fragments[a], fragments[b]
            has_a, ax, ay, height_a = fa.line()
            has_b, bx, by, height_b = fb.line()
            if not has_a and not has_b:
                ok = g <= _limit(LOOSE_FACTOR, min(height_a, height_b), LOOSE_MM)
                if TRACE is not None:
                    TRACE.append(("loose", round(g), boxes[i][:2], boxes[j][:2], ok, round(height_a), round(height_b)))
                if ok:
                    union(a, b)
                continue
            # The letter height comes from whichever side already shows a line of
            # writing: a faint scrap of a stroke next to a word is judged by the word.
            if has_a and has_b:
                height = min(height_a, height_b)
            else:
                height = height_a if has_a else height_b
            if g > _limit(LINE_FACTOR, height, LINE_MM):
                if TRACE is not None:
                    TRACE.append(("far", round(g), boxes[i][:2], boxes[j][:2], False, round(height_a), round(height_b), has_a, has_b))
                continue
            (cax, cay), (cbx, cby) = fa.centre, fb.centre
            in_line = True
            if has_a and abs(-ay * (cbx - cax) + ax * (cby - cay)) > LINE_OFFSET * height_a:
                in_line = False
            if has_b and abs(-by * (cax - cbx) + bx * (cay - cby)) > LINE_OFFSET * height_b:
                in_line = False
            if has_a and has_b and abs(ax * bx + ay * by) < 0.8:  # lines more than ~37 degrees apart
                in_line = False
            if TRACE is not None:
                off_a = abs(-ay * (cbx - cax) + ax * (cby - cay))
                off_b = abs(-by * (cax - cbx) + bx * (cay - cby))
                TRACE.append(("line", round(g), boxes[i][:2], boxes[j][:2], in_line, round(height_a), round(height_b), has_a, has_b, round(off_a), round(off_b), round(abs(ax * bx + ay * by), 2)))
            if in_line:
                union(a, b)

    return [np.concatenate([points[i] for i in fragment.letters]) for fragment in fragments.values()]


def _inside_bands(inside: np.ndarray | None, shape: tuple[int, int], margin: int) -> tuple[np.ndarray, np.ndarray]:
    """(where ink may be, where a word may reach) for a play area of any shape.

    The whole rectified image for a rectangle, or the drawn shape's interior,
    each kept `margin` (and a couple more pixels) clear of the border line.
    """
    area = np.full(shape, 255, np.uint8) if inside is None else inside.copy()
    area[[0, -1], :] = 0
    area[:, [0, -1]] = 0
    allowed = cv2.erode(area, cv2.getStructuringElement(cv2.MORPH_RECT, (2 * margin - 1, 2 * margin - 1)))
    reach = cv2.erode(area, cv2.getStructuringElement(cv2.MORPH_RECT, (2 * margin + 5, 2 * margin + 5)))
    return allowed, reach


def detect(
    rect_bgr: np.ndarray, backdrop: Backdrop | None = None, now: float = 0.0, inside: np.ndarray | None = None
) -> DetectResult:
    """`inside`: optional uint8 mask of the play area (255 inside); None means the whole image."""
    gray = cv2.cvtColor(rect_bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    paper = _paper_level(gray)

    ratio = (gray.astype(np.float32) + 1.0) / (paper.astype(np.float32) + 1.0)
    weak = ((ratio < INK_RATIO) & (paper > PAPER_MIN_LEVEL)).astype(np.uint8)
    # Keep a faint stroke only if it is part of something with a properly dark core.
    count, blobs = cv2.connectedComponents(weak, connectivity=8)
    keep = np.zeros(count, dtype=bool)
    keep[np.unique(blobs[(ratio < INK_CORE_RATIO) & (weak > 0)])] = True
    keep[0] = False
    ink = keep[blobs].astype(np.uint8) * 255
    ink = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))

    margin = mm(EDGE_MARGIN_MM)
    allowed, reach = _inside_bands(inside, (h, w), margin)
    ink[allowed == 0] = 0

    # Paper brightness and colour are measured inside the play area only: outside
    # a drawn circle there may be bare sheet or wooden table.
    in_area = allowed > 0 if np.any(allowed) else np.ones((h, w), bool)
    lit = float(np.percentile(paper[in_area], 85))
    # Colour is judged on a smoothed quarter-size copy: ink and noise drop out.
    small = cv2.medianBlur(cv2.resize(rect_bgr, (w // 4, h // 4), interpolation=cv2.INTER_AREA), 5)
    lab = cv2.cvtColor(small, cv2.COLOR_BGR2LAB).astype(np.float32)
    small_in = cv2.resize(in_area.astype(np.uint8), (w // 4, h // 4), interpolation=cv2.INTER_NEAREST) > 0
    if not np.any(small_in):
        small_in[:] = True
    chroma = np.hypot(lab[:, :, 1] - np.median(lab[:, :, 1][small_in]), lab[:, :, 2] - np.median(lab[:, :, 2][small_in]))
    coloured = cv2.resize((chroma > OCCLUDER_CHROMA).astype(np.uint8) * 255, (w, h), interpolation=cv2.INTER_NEAREST)
    raw = ((gray < OCCLUDER_DARK * lit) | (coloured > 0)).astype(np.uint8) * 255
    # Keep only what is thicker than any pen stroke, then grow it to cover its fuzzy edge.
    k = odd(mm(OCCLUDER_MIN_MM))
    g = odd(mm(6.0))
    solid = cv2.morphologyEx(raw, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
    solid = cv2.dilate(solid, np.ones((g, g), np.uint8))

    # Ink that sits on a solid object (creases between fingers, sleeve seams) is not a card.
    ink[solid > 0] = 0

    # For deciding whether a missing card is merely covered, also count patches
    # that have just gone much dimmer than usual (a grey sleeve, a leaning arm).
    occluder = solid
    if backdrop is not None:
        dimmer = backdrop.update(paper[::4, ::4], now)  # quarter size is plenty
        dimmer = cv2.resize(dimmer, (w, h), interpolation=cv2.INTER_NEAREST)
        dimmer = cv2.morphologyEx(dimmer, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
        occluder = cv2.bitwise_or(solid, cv2.dilate(dimmer, np.ones((g, g), np.uint8)))

    detections: list[Detection] = []
    for points in _group_letters(ink):
        px, py = points[:, 0].astype(np.int32), points[:, 1].astype(np.int32)
        if np.any(reach[py, px] == 0):
            continue  # runs off the play area: the border line or an arm, not a card
        if len(points) < MIN_INK_MM2 * PX_PER_MM * PX_PER_MM:
            continue
        (cx, cy), (rw, rh), angle = cv2.minAreaRect(points)
        if rw < rh:
            rw, rh = rh, rw
            angle += 90.0
        long_mm, short_mm = rw / PX_PER_MM, rh / PX_PER_MM
        if not (WORD_LONG_MM[0] <= long_mm <= WORD_LONG_MM[1]):
            continue
        if not (WORD_SHORT_MM[0] <= short_mm <= WORD_SHORT_MM[1]):
            continue
        fill = len(points) / max(rw * rh, 1.0)
        if not (0.03 <= fill <= 0.7):
            continue
        detections.append(
            Detection(
                x=float(cx), y=float(cy), angle=float(angle), long=float(rw), short=float(rh),
                ink=len(points) / (PX_PER_MM * PX_PER_MM),
            )
        )
    return DetectResult(detections=detections, ink=ink, occluder=occluder)

"""Find the hand-drawn play area border and keep a stable top-down mapping.

The border is any thick dark closed line on a light sheet: a rectangle, a
circle, a blob. We look for the light region it encloses (its inner edge).

Every play area is described by a *frame*: four image points that map to the
corners of the rectified (top-down) image, long side first, plus the outline
of the region inside that frame. The world takes the frame's proportions and
the outline's shape.

- A four-sided border gets straight lines fitted to its sides, and its corners
  are the frame (perspective comes from the corners, as before).
- Any other shape takes its perspective from the sheet's own edge when that is
  in view: the frame is the shape's bounding box on the sheet.
- With no sheet edge either, the phone is assumed to look roughly straight
  down and the frame is the shape's smallest enclosing rectangle.

Once locked, the shape is fixed: the drawn border does not change while the
game is played. Small movements (a nudged phone) are followed smoothly. A hand
reaching in is recognised (the locked area with a piece missing) and ignored.
Only a different border that stays put for a while replaces the locked one.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from . import PLAY_H_MM, PLAY_W_MM, RECT_W

DETECT_LONG_SIDE = 960  # work at this size for speed
MIN_AREA_FRACTION = 0.03  # play area must fill at least this much of the frame
MIN_SOLIDITY = 0.5  # area / convex hull area: rejects slivers between fingers and the like
MIN_THICKNESS = 0.15  # short side / long side of the enclosing rectangle
A3_ASPECT = PLAY_W_MM / PLAY_H_MM
ASPECT_SNAP = 0.08  # a four-sided border this close to A3 proportions is treated as exactly A3
ASPECT_KEEP = 0.04  # while following, proportions within this much are not changed (no jitter)
FOLLOW_DISTANCE = 0.04  # of the frame diagonal: closer than this is "the same area, nudged"
SWITCH_SECONDS = 0.7  # the same border somewhere else (phone re-propped) must persist this long
NEW_BORDER_SECONDS = 1.5  # a differently shaped border must persist this long
UNMEASURED_SECONDS = 3.0  # ... and this long if it lacks the sheet edge the locked one was measured against
COMPARE_LONG_SIDE = 320  # outlines are compared with the locked area at this size
CHUNK = 0.004  # a solid piece this share of the locked area counts as missing or added
SHARED_EDGE = 0.2  # a hand's bite: at least this share of the candidate's edge runs along the locked edge...
KEPT_EDGE = 0.35  # ... and at least this share of the locked edge is still there in the candidate
COINCIDE = 0.9  # overlap with the locked area above which an outline is in the same place
SAME_SHAPE = 0.96  # overlap of two shapes, camera view removed, above which they are the same shape
SHAPE_GRID = 128
LOCK_FRAMES = 3
UNIT_RECT = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]


@dataclass
class Outline:
    """One candidate play area, in camera image pixels."""

    frame: np.ndarray  # 4x2, ordered clockwise from top-left, long side first
    contour: np.ndarray  # Nx2, the inner edge of the border (simplified)
    aspect: float  # long side / short side of the frame, >= 1
    area: float  # image px^2, for innermost-first ordering
    four_sided: bool
    measured: bool = False  # frame and proportions come from the sheet's edge, not a guess


def _order_corners(pts: np.ndarray) -> np.ndarray:
    """Order 4 points clockwise starting from the image's top-left."""
    centre = pts.mean(axis=0)
    angles = np.arctan2(pts[:, 1] - centre[1], pts[:, 0] - centre[0])
    pts = pts[np.argsort(angles)]  # clockwise in image coordinates (y down)
    start = int(np.argmin(pts.sum(axis=1)))
    return np.roll(pts, -start, axis=0)


def _refine_with_lines(contour: np.ndarray, quad: np.ndarray) -> np.ndarray:
    """Replace approximate corners with intersections of lines fitted to each side.

    Hand-drawn corners are rounded and wobbly; the sides are far more reliable.
    """
    pts = contour.reshape(-1, 2).astype(np.float32)
    lines = []
    for i in range(4):
        a, b = quad[i], quad[(i + 1) % 4]
        ab = b - a
        length = float(np.linalg.norm(ab))
        if length < 1:
            return quad
        direction = ab / length
        rel = pts - a
        along = rel @ direction
        across = np.abs(rel @ np.array([-direction[1], direction[0]], dtype=np.float32))
        keep = (along > 0.12 * length) & (along < 0.88 * length) & (across < 0.04 * length + 3)
        side = pts[keep]
        if len(side) < 8:
            return quad
        vx, vy, x0, y0 = cv2.fitLine(side, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        lines.append((float(vx), float(vy), float(x0), float(y0)))
    corners = []
    for i in range(4):
        v1 = lines[(i - 1) % 4]
        v2 = lines[i]
        m = np.array([[v1[0], -v2[0]], [v1[1], -v2[1]]], dtype=np.float64)
        if abs(np.linalg.det(m)) < 1e-9:
            return quad
        t = np.linalg.solve(m, np.array([v2[2] - v1[2], v2[3] - v1[3]], dtype=np.float64))
        corners.append([v1[2] + t[0] * v1[0], v1[3] + t[0] * v1[1]])
    refined = np.array(corners, dtype=np.float32)
    # Guard against a wild fit.
    if np.max(np.linalg.norm(refined - quad, axis=1)) > 0.15 * np.linalg.norm(quad[0] - quad[2]):
        return quad
    return refined


def _as_quad(contour: np.ndarray) -> np.ndarray | None:
    """The four corners if this outline is a four-sided shape, else None."""
    approx = cv2.approxPolyDP(contour, 0.02 * cv2.arcLength(contour, True), True)
    if len(approx) != 4 or not cv2.isContourConvex(approx):
        return None
    quad = _order_corners(approx.reshape(4, 2).astype(np.float32))
    sides = [np.linalg.norm(quad[i] - quad[(i + 1) % 4]) for i in range(4)]
    if min(sides) < 0.15 * max(sides):
        return None
    return _order_corners(_refine_with_lines(contour, quad))


def _long_side_first(quad: np.ndarray) -> np.ndarray:
    """Rotate the corner order so corner 0 -> 1 runs along a long side."""
    horizontal = np.linalg.norm(quad[0] - quad[1]) + np.linalg.norm(quad[3] - quad[2])
    vertical = np.linalg.norm(quad[0] - quad[3]) + np.linalg.norm(quad[1] - quad[2])
    if horizontal >= vertical:
        return quad
    return np.roll(quad, 1, axis=0)  # sheet appears portrait in the image


def _to_sheet(sheet: np.ndarray) -> np.ndarray:
    """Homography from image pixels to millimetres on the sheet (taken as A3 landscape)."""
    plane = np.array([[0, 0], [PLAY_W_MM, 0], [PLAY_W_MM, PLAY_H_MM], [0, PLAY_H_MM]], dtype=np.float32)
    return cv2.getPerspectiveTransform(_long_side_first(sheet).astype(np.float32), plane)


def _quad_aspect(quad: np.ndarray, sheet: np.ndarray | None) -> float:
    """Long / short side of a four-sided border, snapped to A3 when close.

    Measured on the sheet when its edge is in view (the camera's perspective
    would distort a measurement taken in the image); otherwise taken as A3.
    """
    if sheet is None:
        return A3_ASPECT
    q = cv2.perspectiveTransform(quad.reshape(-1, 1, 2).astype(np.float32), _to_sheet(sheet)).reshape(4, 2)
    a = (np.linalg.norm(q[0] - q[1]) + np.linalg.norm(q[3] - q[2])) / 2
    b = (np.linalg.norm(q[0] - q[3]) + np.linalg.norm(q[1] - q[2])) / 2
    aspect = float(max(a, b) / max(1e-6, min(a, b)))
    return A3_ASPECT if abs(aspect / A3_ASPECT - 1) < ASPECT_SNAP else aspect


def _frame_on_sheet(contour: np.ndarray, sheet: np.ndarray) -> tuple[np.ndarray, float]:
    """Frame for a shape drawn on a sheet whose four corners we can see.

    The sheet gives the perspective; the frame is the shape's bounding box
    measured on the sheet (taken as A3), mapped back into the image.
    """
    to_plane = _to_sheet(sheet)
    on_plane = cv2.perspectiveTransform(contour.reshape(-1, 1, 2).astype(np.float32), to_plane).reshape(-1, 2)
    x0, y0 = on_plane.min(axis=0)
    x1, y1 = on_plane.max(axis=0)
    box = np.array([[[x0, y0]], [[x1, y0]], [[x1, y1]], [[x0, y1]]], dtype=np.float32)
    frame = cv2.perspectiveTransform(box, np.linalg.inv(to_plane)).reshape(4, 2)
    w, h = float(x1 - x0), float(y1 - y0)
    if w >= h:
        return frame, w / max(h, 1e-6)
    return np.roll(frame, 1, axis=0), h / max(w, 1e-6)


def _frame_overhead(contour: np.ndarray) -> tuple[np.ndarray, float]:
    """Frame for a shape with no sheet edge in view: its smallest enclosing rectangle."""
    box = cv2.minAreaRect(contour.astype(np.float32))
    (_, _), (w, h), _ = box
    frame = _long_side_first(_order_corners(cv2.boxPoints(box)))
    return frame, float(max(w, h) / max(1e-6, min(w, h)))


def find_outlines(gray: np.ndarray) -> list[Outline]:
    """Every plausible play area, innermost first.

    A drawn border gives its inner edge; the edge of the sheet itself (light
    paper on a darker table) also qualifies, so a thin or broken pen line
    still leaves the sheet as the play area.
    """
    h, w = gray.shape
    scale = DETECT_LONG_SIDE / max(h, w)
    small = cv2.resize(gray, (int(round(w * scale)), int(round(h * scale))), interpolation=cv2.INTER_AREA)
    small = cv2.GaussianBlur(small, (3, 3), 0)
    dark = cv2.adaptiveThreshold(small, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 51, 9)
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    contours, hierarchy = cv2.findContours(dark, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hierarchy is None:
        return []
    frame_area = small.shape[0] * small.shape[1]

    holes: list[tuple[float, np.ndarray, np.ndarray | None]] = []
    for contour, info in zip(contours, hierarchy[0]):
        if info[3] == -1:  # only holes: light regions enclosed by a dark line
            continue
        area = cv2.contourArea(contour)
        if area < MIN_AREA_FRACTION * frame_area:
            continue
        hull = cv2.contourArea(cv2.convexHull(contour))
        (_, _), (rw, rh), _ = cv2.minAreaRect(contour)
        if hull <= 0 or area / hull < MIN_SOLIDITY or min(rw, rh) < MIN_THICKNESS * max(rw, rh):
            continue
        holes.append((area, contour, _as_quad(contour)))

    found: list[Outline] = []
    for area, contour, quad in holes:
        # The sheet: the smallest four-sided outline around this one, if any.
        centre = contour.reshape(-1, 2).mean(axis=0)
        sheets = [
            (a, q) for a, _, q in holes
            if q is not None and a > 1.15 * area
            and cv2.pointPolygonTest(q.reshape(-1, 1, 2), (float(centre[0]), float(centre[1])), False) > 0
        ]
        sheet = min(sheets, key=lambda s: s[0])[1] if sheets else None
        if quad is not None:
            frame = _long_side_first(quad)
            found.append(Outline(frame / scale, frame / scale, _quad_aspect(frame, sheet), area / scale**2, True, sheet is not None))
            continue
        points = cv2.approxPolyDP(contour, 0.002 * cv2.arcLength(contour, True), True).reshape(-1, 2).astype(np.float32)
        if sheet is not None:
            frame, aspect = _frame_on_sheet(points, sheet)
        else:
            frame, aspect = _frame_overhead(points)
        found.append(Outline(frame / scale, points / scale, aspect, area / scale**2, False, sheet is not None))
    found.sort(key=lambda o: o.area)
    return found


def find_quads(gray: np.ndarray) -> list[np.ndarray]:
    """Frames of every plausible play area (4x2, image pixels), innermost first."""
    return [o.frame for o in find_outlines(gray)]


def find_quad(gray: np.ndarray) -> np.ndarray | None:
    """The innermost plausible play-area frame, or None."""
    quads = find_quads(gray)
    return quads[0] if quads else None


def _unit_shape(outline: Outline) -> np.ndarray:
    """The outline as fractions (0..1) of its own frame: the shape with the camera's view taken out."""
    unit = np.array(UNIT_RECT, dtype=np.float32)
    if outline.four_sided:
        return unit
    to_unit = cv2.getPerspectiveTransform(outline.frame.astype(np.float32), unit)
    return cv2.perspectiveTransform(outline.contour.reshape(-1, 1, 2).astype(np.float32), to_unit).reshape(-1, 2)


def _shape_overlap(a: np.ndarray, b: np.ndarray) -> float:
    """How alike two unit shapes are: shared area / combined area."""
    masks = []
    for shape in (a, b):
        mask = np.zeros((SHAPE_GRID, SHAPE_GRID), np.uint8)
        cv2.fillPoly(mask, [np.round(shape * (SHAPE_GRID - 1)).astype(np.int32)], 255)
        masks.append(mask > 0)
    union = np.count_nonzero(masks[0] | masks[1])
    return np.count_nonzero(masks[0] & masks[1]) / union if union else 0.0


@dataclass
class _Versus:
    """How a candidate outline sits against the locked play area, in the camera image."""

    overlap: float  # shared area / combined area
    lost: float  # share of the locked area the candidate lacks, counting solid chunks only (not a thin rim)
    gained: float  # share of the locked area the candidate adds, counting solid chunks only
    shared: float  # share of the candidate's edge that runs along the locked edge
    kept: float  # share of the locked edge that runs along the candidate's edge

    @property
    def bitten(self) -> bool:
        """The locked area with a piece taken out: a hand or arm reaching in over the border.

        Most of the locked edge is still there. (A new border drawn inside the
        old one, such as a circle that touches it, keeps very little of it.)
        """
        return self.lost >= CHUNK and self.gained < CHUNK and self.shared >= SHARED_EDGE and self.kept >= KEPT_EDGE

    @property
    def fuller(self) -> bool:
        """The locked area plus a piece: we locked while something was covering part of it."""
        return self.gained >= CHUNK and self.lost < CHUNK and self.kept >= SHARED_EDGE and self.shared >= KEPT_EDGE

    @property
    def ring(self) -> bool:
        """Wholly inside or wholly around the locked area and not one of the above: another line (pen border vs sheet edge)."""
        return (self.lost >= CHUNK) != (self.gained >= CHUNK) and not self.bitten and not self.fuller


class PlayArea:
    """Tracks the play area over time and provides the top-down transform.

    The drawn border does not change while the game is played, so once locked
    its shape is fixed. Later frames may only move it (a nudged phone). A hand
    reaching in hides part of the area; the outline the camera then sees is the
    locked one with a piece missing, and it is ignored.
    """

    def __init__(self) -> None:
        self.corners: np.ndarray | None = None  # frame, image px, ordered, long side first
        self.contour: np.ndarray | None = None  # outline, image px (the fixed shape at the current corners)
        self.shape: np.ndarray | None = None  # outline as fractions of the frame; fixed while locked
        self.aspect = A3_ASPECT
        self.four_sided = True
        self.measured = False  # proportions were measured against the sheet's edge
        self.locked = False
        self.flip = False  # user toggle: rotate the table 180 degrees
        self.last_seen = 0.0
        self._streak = 0
        self._pending: Outline | None = None
        self._pending_since = 0.0
        self._diag = 1.0
        self._size = (1, 1)  # camera image, (w, h)

    def relock(self) -> None:
        self.corners = None
        self.contour = None
        self.shape = None
        self.locked = False
        self._streak = 0
        self._pending = None

    def found(self, now: float) -> bool:
        """True if the border was actually seen in the last second (a hand over part of it still counts)."""
        return self.locked and (now - self.last_seen) < 1.0

    def _take(self, outline: Outline) -> None:
        self.corners = outline.frame.astype(np.float32).copy()
        self.shape = _unit_shape(outline)
        self.aspect = outline.aspect
        self.four_sided = outline.four_sided
        self.measured = outline.measured
        self._place()

    def _place(self) -> None:
        """Put the fixed shape where the corners now are."""
        if self.four_sided:
            self.contour = self.corners.copy()
            return
        from_unit = cv2.getPerspectiveTransform(np.array(UNIT_RECT, dtype=np.float32), self.corners.astype(np.float32))
        self.contour = cv2.perspectiveTransform(self.shape.reshape(-1, 1, 2).astype(np.float32), from_unit).reshape(-1, 2)

    def _aligned(self, outline: Outline) -> Outline:
        """Keep the same corner numbering as before.

        The ordering can flip by 180 degrees when the phone is close to
        square-on, and by 90 when the area is close to square (a circle).
        """
        turns = (0, 1, 2, 3) if max(outline.aspect, self.aspect) < 1.2 else (0, 2)
        best = min(turns, key=lambda t: self._distance(np.roll(outline.frame, t, axis=0), self.corners))
        if best:
            outline.frame = np.roll(outline.frame, best, axis=0)
        return outline

    def _versus(self, outline: Outline) -> _Versus:
        """Compare a candidate with the locked area where they lie in the camera image."""
        scale = COMPARE_LONG_SIDE / max(self._size)
        w, h = int(round(self._size[0] * scale)), int(round(self._size[1] * scale))

        def draw(points: np.ndarray, fill: bool) -> np.ndarray:
            mask = np.zeros((h, w), np.uint8)
            pts = [np.round(points * scale).astype(np.int32)]
            if fill:
                cv2.fillPoly(mask, pts, 255)
            else:
                cv2.polylines(mask, pts, True, 255, 1)
            return mask

        locked, candidate = draw(self.contour, True), draw(outline.contour, True)
        area = max(1, np.count_nonzero(locked))
        union = max(1, np.count_nonzero(locked | candidate))
        # Opening drops the thin rim a small shift leaves, keeping only solid pieces.
        solid = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        lost = cv2.morphologyEx(locked & ~candidate, cv2.MORPH_OPEN, solid)
        gained = cv2.morphologyEx(candidate & ~locked, cv2.MORPH_OPEN, solid)
        reach = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
        locked_edge, edge = draw(self.contour, False), draw(outline.contour, False)
        near_locked, near_candidate = cv2.dilate(locked_edge, reach), cv2.dilate(edge, reach)
        return _Versus(
            overlap=np.count_nonzero(locked & candidate) / union,
            lost=np.count_nonzero(lost) / area,
            gained=np.count_nonzero(gained) / area,
            shared=np.count_nonzero(edge & near_locked) / max(1, np.count_nonzero(edge)),
            kept=np.count_nonzero(locked_edge & near_candidate) / max(1, np.count_nonzero(locked_edge)),
        )

    def _same_border(self, outline: Outline) -> bool:
        """Could this be the locked border itself, perhaps seen from a slightly different place?"""
        if outline.four_sided != self.four_sided:
            return False
        if self.four_sided:
            return True  # a rectangle's shape is all in its corners
        if self.measured and not outline.measured:
            return False  # its frame was guessed without the sheet's edge: not comparable
        return abs(outline.aspect / self.aspect - 1) < ASPECT_SNAP and _shape_overlap(_unit_shape(outline), self.shape) >= SAME_SHAPE

    def update(self, gray: np.ndarray, now: float) -> None:
        self._diag = float(np.hypot(*gray.shape))
        self._size = (gray.shape[1], gray.shape[0])
        outlines = find_outlines(gray)
        if not outlines:
            self._streak = 0
            return
        if self.corners is None:
            self._take(outlines[0])
            self._streak = 1
            return
        outlines = [self._aligned(o) for o in outlines]
        if self.locked:
            self._hold(outlines, now)
            return
        # Not locked yet: wait until the same outline has been seen a few frames running.
        outline = min(outlines, key=lambda o: self._distance(o.frame, self.corners))
        if self._distance(outline.frame, self.corners) < FOLLOW_DISTANCE:
            self._streak += 1
            if self._streak >= LOCK_FRAMES:
                self.locked = True
                self.last_seen = now
        else:
            self._streak = 1
        self._take(outline)

    def _hold(self, outlines: list[Outline], now: float) -> None:
        """Locked: follow the border if it moved, ignore hands, switch only to a lasting different border."""
        judged = [(o, self._versus(o)) for o in outlines]
        # The locked border is plainly still where it was: seen whole, or with a hand over part of it.
        still_there = any(v.bitten or (v.overlap >= COINCIDE and not v.fuller) for _, v in judged)

        follow = [
            (o, v) for o, v in judged
            # Several outlines can qualify (pen border, sheet edge). One lying wholly inside or
            # around ours is a different line, not ours nudged: do not drift over to it.
            if not v.bitten and not v.ring
            and self._same_border(o) and self._distance(o.frame, self.corners) < FOLLOW_DISTANCE
        ]
        if follow:
            outline, versus = min(follow, key=lambda item: self._distance(item[0].frame, self.corners))
            if versus.fuller and not self.four_sided:
                self._take(outline)  # we had locked with part of the area covered: this is the whole of it
            else:
                self.corners = self.corners + 0.35 * (outline.frame - self.corners)
                # Proportions only ever come from a measurement against the sheet's edge.
                if self.four_sided and outline.measured and (
                    not self.measured or abs(outline.aspect / self.aspect - 1) > ASPECT_KEEP
                ):
                    self.aspect = outline.aspect
                    self.measured = True
                self._place()
            self.last_seen = now
            self._pending = None
            return
        if still_there:
            # A hand is in the way, or only the sheet's edge is hidden. Nothing has moved: keep everything.
            self.last_seen = now
            self._pending = None
            return

        # Something different: the phone was re-propped, a new border was drawn, or this is a bad frame.
        others = [o for o, v in judged if not v.bitten]
        if not others:
            return
        outline = others[0]  # innermost first, as when first locking: the drawn border, not the sheet around it
        if self._same_border(outline):
            wait = SWITCH_SECONDS
        elif self.measured and not outline.measured:
            wait = UNMEASURED_SECONDS
        else:
            wait = NEW_BORDER_SECONDS
        if self._pending is not None and self._distance(outline.frame, self._pending.frame) < FOLLOW_DISTANCE:
            if now - self._pending_since >= wait:
                self._take(outline)
                self.last_seen = now
                self._pending = None
        else:
            self._pending = outline
            self._pending_since = now

    def _distance(self, a: np.ndarray, b: np.ndarray) -> float:
        """Largest corner movement as a fraction of the frame diagonal."""
        return float(np.max(np.linalg.norm(a - b, axis=1))) / self._diag

    def ordered_corners(self) -> np.ndarray | None:
        """Corners as far-left, far-right, near-right, near-left of the table."""
        if self.corners is None:
            return None
        return np.roll(self.corners, 2, axis=0) if self.flip else self.corners

    def rect_size(self) -> tuple[int, int]:
        """Size of the rectified image: always RECT_W wide, as tall as the area's proportions say."""
        return RECT_W, int(round(RECT_W / self.aspect))

    def homography(self) -> np.ndarray | None:
        """Image pixels -> rectified top-down pixels (rect_size())."""
        corners = self.ordered_corners()
        if corners is None or not self.locked:
            return None
        w, h = self.rect_size()
        target = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float32)
        return cv2.getPerspectiveTransform(corners.astype(np.float32), target)

    def outline(self) -> list[list[float]] | None:
        """The play area's shape, as points 0..1 across the rectified image."""
        homography = self.homography()
        if homography is None or self.contour is None:
            return None
        if self.four_sided:
            return [list(p) for p in UNIT_RECT]
        w, h = self.rect_size()
        pts = cv2.perspectiveTransform(self.contour.reshape(-1, 1, 2).astype(np.float32), homography).reshape(-1, 2)
        pts = np.clip(pts / np.array([w, h], dtype=np.float32), 0.0, 1.0)
        return [[round(float(x), 4), round(float(y), 4)] for x, y in pts]

    def inside_mask(self) -> np.ndarray | None:
        """uint8 mask over the rectified image: 255 inside the play area."""
        shape = self.outline()
        if shape is None:
            return None
        w, h = self.rect_size()
        mask = np.zeros((h, w), np.uint8)
        pts = np.round(np.array(shape, dtype=np.float32) * np.array([w, h], dtype=np.float32)).astype(np.int32)
        cv2.fillPoly(mask, [pts], 255)
        return mask

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

After locking, small movements (a nudged phone) are followed smoothly; frames
where a hand breaks the border are ignored; a clearly different area must
persist before we switch to it.
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
SWITCH_SECONDS = 0.7  # a different area must persist this long before we jump to it
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
            found.append(Outline(frame / scale, frame / scale, _quad_aspect(frame, sheet), area / scale**2, True))
            continue
        points = cv2.approxPolyDP(contour, 0.002 * cv2.arcLength(contour, True), True).reshape(-1, 2).astype(np.float32)
        if sheet is not None:
            frame, aspect = _frame_on_sheet(points, sheet)
        else:
            frame, aspect = _frame_overhead(points)
        found.append(Outline(frame / scale, points / scale, aspect, area / scale**2, False))
    found.sort(key=lambda o: o.area)
    return found


def find_quads(gray: np.ndarray) -> list[np.ndarray]:
    """Frames of every plausible play area (4x2, image pixels), innermost first."""
    return [o.frame for o in find_outlines(gray)]


def find_quad(gray: np.ndarray) -> np.ndarray | None:
    """The innermost plausible play-area frame, or None."""
    quads = find_quads(gray)
    return quads[0] if quads else None


class PlayArea:
    """Tracks the play area over time and provides the top-down transform."""

    def __init__(self) -> None:
        self.corners: np.ndarray | None = None  # frame, image px, ordered, long side first
        self.contour: np.ndarray | None = None  # outline, image px
        self.aspect = A3_ASPECT
        self.four_sided = True
        self.locked = False
        self.flip = False  # user toggle: rotate the table 180 degrees
        self.last_seen = 0.0
        self._streak = 0
        self._pending: Outline | None = None
        self._pending_since = 0.0
        self._diag = 1.0

    def relock(self) -> None:
        self.corners = None
        self.contour = None
        self.locked = False
        self._streak = 0
        self._pending = None

    def found(self, now: float) -> bool:
        """True if the border was actually seen in the last second."""
        return self.locked and (now - self.last_seen) < 1.0

    def _take(self, outline: Outline) -> None:
        self.corners = outline.frame
        self.contour = outline.contour
        self.aspect = outline.aspect
        self.four_sided = outline.four_sided

    def update(self, gray: np.ndarray, now: float) -> None:
        self._diag = float(np.hypot(*gray.shape))
        outlines = find_outlines(gray)
        if not outlines:
            self._streak = 0
            return
        if self.corners is None:
            self._take(outlines[0])
            self._streak = 1
            return

        def aligned(o: Outline) -> Outline:
            # Keep the same corner numbering as before (the ordering can flip
            # by 180 degrees when the phone is close to square-on).
            turned = np.roll(o.frame, 2, axis=0)
            if np.max(np.linalg.norm(turned - self.corners, axis=1)) < np.max(np.linalg.norm(o.frame - self.corners, axis=1)):
                o.frame = turned
            return o

        # Several outlines can qualify (pen border, sheet edge). Stay with the
        # one we are already following rather than hopping between them.
        outlines = [aligned(o) for o in outlines]
        outline = min(outlines, key=lambda o: self._distance(o.frame, self.corners))
        distance = self._distance(outline.frame, self.corners)
        if not self.locked:
            if distance < FOLLOW_DISTANCE:
                self._streak += 1
                if self._streak >= LOCK_FRAMES:
                    self.locked = True
                    self.last_seen = now
            else:
                self._streak = 1
            self._take(outline)
            return
        if distance < FOLLOW_DISTANCE:
            self.corners = self.corners + 0.35 * (outline.frame - self.corners)
            self.contour = outline.contour
            self.four_sided = outline.four_sided
            if abs(outline.aspect / self.aspect - 1) > ASPECT_KEEP:
                self.aspect = outline.aspect
            self.last_seen = now
            self._pending = None
            return
        # Something different: the phone was re-propped, or this is a bad frame.
        if self._pending is not None and self._distance(outline.frame, self._pending.frame) < FOLLOW_DISTANCE:
            if now - self._pending_since >= SWITCH_SECONDS:
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

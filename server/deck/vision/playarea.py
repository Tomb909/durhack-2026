"""Find the hand-drawn play area border and keep a stable top-down mapping.

The border is a thick dark closed rectangle on a light sheet. We look for the
*inner* edge of that rectangle (the light region it encloses), fit straight
lines to its four sides, and lock on. After locking, small movements (a nudged
phone) are followed smoothly; frames where a hand breaks the border are
ignored; a clearly different rectangle must persist before we switch to it.
"""

from __future__ import annotations

import cv2
import numpy as np

from . import RECT_H, RECT_W

DETECT_LONG_SIDE = 960  # work at this size for speed
MIN_AREA_FRACTION = 0.10  # play area must fill at least this much of the frame
FOLLOW_DISTANCE = 0.04  # of the frame diagonal: closer than this is "the same quad, nudged"
SWITCH_SECONDS = 0.7  # a different quad must persist this long before we jump to it
LOCK_FRAMES = 3


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


def find_quad(gray: np.ndarray) -> np.ndarray | None:
    """Return the play area's inner corners (4x2, image pixels, ordered) or None."""
    h, w = gray.shape
    scale = DETECT_LONG_SIDE / max(h, w)
    small = cv2.resize(gray, (int(round(w * scale)), int(round(h * scale))), interpolation=cv2.INTER_AREA)
    small = cv2.GaussianBlur(small, (5, 5), 0)
    dark = cv2.adaptiveThreshold(small, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 51, 12)
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    contours, hierarchy = cv2.findContours(dark, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hierarchy is None:
        return None
    frame_area = small.shape[0] * small.shape[1]
    best: tuple[float, np.ndarray] | None = None
    for contour, info in zip(contours, hierarchy[0]):
        if info[3] == -1:  # only holes: light regions enclosed by a dark line
            continue
        area = cv2.contourArea(contour)
        if area < MIN_AREA_FRACTION * frame_area:
            continue
        approx = cv2.approxPolyDP(contour, 0.02 * cv2.arcLength(contour, True), True)
        if len(approx) != 4 or not cv2.isContourConvex(approx):
            continue
        quad = _order_corners(approx.reshape(4, 2).astype(np.float32))
        sides = [np.linalg.norm(quad[i] - quad[(i + 1) % 4]) for i in range(4)]
        if min(sides) < 0.15 * max(sides):
            continue
        # Innermost qualifying region wins: the paper's own edge can also form one.
        if best is None or area < best[0]:
            best = (area, _order_corners(_refine_with_lines(contour, quad)))
    if best is None:
        return None
    return best[1] / scale


def _long_side_first(quad: np.ndarray) -> np.ndarray:
    """Rotate the corner order so corner 0 -> 1 runs along a long side."""
    horizontal = np.linalg.norm(quad[0] - quad[1]) + np.linalg.norm(quad[3] - quad[2])
    vertical = np.linalg.norm(quad[0] - quad[3]) + np.linalg.norm(quad[1] - quad[2])
    if horizontal >= vertical:
        return quad
    return np.roll(quad, 1, axis=0)  # sheet appears portrait in the image


class PlayArea:
    """Tracks the play area over time and provides the top-down transform."""

    def __init__(self) -> None:
        self.corners: np.ndarray | None = None  # image px, ordered, long side first
        self.locked = False
        self.flip = False  # user toggle: rotate the table 180 degrees
        self.last_seen = 0.0
        self._streak = 0
        self._pending: np.ndarray | None = None
        self._pending_since = 0.0
        self._diag = 1.0

    def relock(self) -> None:
        self.corners = None
        self.locked = False
        self._streak = 0
        self._pending = None

    def found(self, now: float) -> bool:
        """True if the border was actually seen in the last second."""
        return self.locked and (now - self.last_seen) < 1.0

    def update(self, gray: np.ndarray, now: float) -> None:
        self._diag = float(np.hypot(*gray.shape))
        quad = find_quad(gray)
        if quad is None:
            self._streak = 0
            return
        quad = _long_side_first(quad)
        if self.corners is None:
            self.corners = quad
            self._streak = 1
            return
        # Keep the same corner numbering as before (the ordering can flip by
        # 180 degrees when the phone is close to square-on).
        turned = np.roll(quad, 2, axis=0)
        if np.max(np.linalg.norm(turned - self.corners, axis=1)) < np.max(
            np.linalg.norm(quad - self.corners, axis=1)
        ):
            quad = turned
        distance = self._distance(quad, self.corners)
        if not self.locked:
            if distance < FOLLOW_DISTANCE:
                self._streak += 1
                self.corners = quad
                if self._streak >= LOCK_FRAMES:
                    self.locked = True
                    self.last_seen = now
            else:
                self.corners = quad
                self._streak = 1
            return
        if distance < FOLLOW_DISTANCE:
            self.corners = self.corners + 0.35 * (quad - self.corners)
            self.last_seen = now
            self._pending = None
            return
        # Something different: the phone was re-propped, or this is a bad frame.
        if self._pending is not None and self._distance(quad, self._pending) < FOLLOW_DISTANCE:
            if now - self._pending_since >= SWITCH_SECONDS:
                self.corners = quad
                self.last_seen = now
                self._pending = None
        else:
            self._pending = quad
            self._pending_since = now

    def _distance(self, a: np.ndarray, b: np.ndarray) -> float:
        """Largest corner movement as a fraction of the frame diagonal."""
        return float(np.max(np.linalg.norm(a - b, axis=1))) / self._diag

    def ordered_corners(self) -> np.ndarray | None:
        """Corners as far-left, far-right, near-right, near-left of the table."""
        if self.corners is None:
            return None
        return np.roll(self.corners, 2, axis=0) if self.flip else self.corners

    def homography(self) -> np.ndarray | None:
        """Image pixels -> rectified top-down pixels (RECT_W x RECT_H)."""
        corners = self.ordered_corners()
        if corners is None or not self.locked:
            return None
        target = np.array([[0, 0], [RECT_W, 0], [RECT_W, RECT_H], [0, RECT_H]], dtype=np.float32)
        return cv2.getPerspectiveTransform(corners.astype(np.float32), target)

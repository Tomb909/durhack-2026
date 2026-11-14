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
INK_RATIO = 0.66  # a stroke pixel is darker than this fraction of its surroundings
PAPER_MIN_LEVEL = 40  # surroundings darker than this are not paper at all
OCCLUDER_DARK = 0.36  # darker than this fraction of the lit paper = a dark object, not a shadow
OCCLUDER_COLOUR = 45  # this much more saturated than the paper = skin, clothing
OCCLUDER_MIN_MM = 8.0  # anything thinner than this is a pen stroke, not an object
EDGE_MARGIN_MM = 5.0
LETTER_JOIN_MM = 2.5  # closes breaks inside a single letter
GAP_FACTOR = 0.9  # letters join into a word when the gap is under this many letter-heights
GAP_MIN_MM = 6.0
GAP_MAX_MM = 20.0
WORD_LONG_MM = (14.0, 190.0)
WORD_SHORT_MM = (5.0, 75.0)
MIN_INK_MM2 = 18.0
MIN_LETTER_MM2 = 1.5


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


def _group_letters(ink: np.ndarray) -> list[np.ndarray]:
    """Group ink blobs (letters) into words. Returns one point array per word.

    Letters join when the gap between them is small compared with their own
    size, so large bold writing and small neat writing both hold together.
    """
    k = odd(mm(LETTER_JOIN_MM))
    joined = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(joined, connectivity=8)
    min_area = MIN_LETTER_MM2 * PX_PER_MM * PX_PER_MM
    letters = [i for i in range(1, count) if stats[i, cv2.CC_STAT_AREA] >= min_area]
    if not letters:
        return []
    boxes = np.array([[stats[i, 0], stats[i, 1], stats[i, 0] + stats[i, 2], stats[i, 1] + stats[i, 3]] for i in letters], dtype=np.float32)
    sizes = np.maximum(boxes[:, 2] - boxes[:, 0], boxes[:, 3] - boxes[:, 1])
    gap_min, gap_max = GAP_MIN_MM * PX_PER_MM, GAP_MAX_MM * PX_PER_MM

    parent = list(range(len(letters)))

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(letters)):
        dx = np.maximum(0, np.maximum(boxes[i, 0] - boxes[:, 2], boxes[:, 0] - boxes[i, 2]))
        dy = np.maximum(0, np.maximum(boxes[i, 1] - boxes[:, 3], boxes[:, 1] - boxes[i, 3]))
        gap = np.hypot(dx, dy)
        reach = np.clip(GAP_FACTOR * np.minimum(sizes[i], sizes), gap_min, gap_max)
        for j in np.nonzero(gap <= reach)[0]:
            if j > i:
                parent[root(int(j))] = root(i)

    groups: dict[int, list[int]] = {}
    for index in range(len(letters)):
        groups.setdefault(root(index), []).append(letters[index])
    words = []
    for members in groups.values():
        mask = np.isin(labels, members) & (ink > 0)
        ys, xs = np.nonzero(mask)
        if len(xs):
            words.append(np.column_stack((xs, ys)).astype(np.float32))
    return words


def detect(rect_bgr: np.ndarray) -> DetectResult:
    gray = cv2.cvtColor(rect_bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    paper = _paper_level(gray)

    ratio = (gray.astype(np.float32) + 1.0) / (paper.astype(np.float32) + 1.0)
    ink = ((ratio < INK_RATIO) & (paper > PAPER_MIN_LEVEL)).astype(np.uint8) * 255
    ink = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))

    margin = mm(EDGE_MARGIN_MM)
    ink[:margin, :] = 0
    ink[-margin:, :] = 0
    ink[:, :margin] = 0
    ink[:, -margin:] = 0

    # Occluders: big things that are clearly not paper. A shadow only dims the
    # paper, so it must be either very dark (a sleeve) or coloured (skin).
    lit = float(np.percentile(paper, 85))
    saturation = cv2.cvtColor(rect_bgr, cv2.COLOR_BGR2HSV)[:, :, 1]
    paper_saturation = float(np.median(saturation))
    raw = ((gray < OCCLUDER_DARK * lit) | (saturation > paper_saturation + OCCLUDER_COLOUR)).astype(np.uint8) * 255
    # Keep only what is thicker than any pen stroke, then grow it to cover its fuzzy edge.
    k = odd(mm(OCCLUDER_MIN_MM))
    occluder = cv2.morphologyEx(raw, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
    g = odd(mm(6.0))
    occluder = cv2.dilate(occluder, np.ones((g, g), np.uint8))

    # Ink that sits on an occluder (creases between fingers, sleeve seams) is not a card.
    ink[occluder > 0] = 0

    detections: list[Detection] = []
    for points in _group_letters(ink):
        x0, y0 = points.min(axis=0)
        x1, y1 = points.max(axis=0)
        if x0 <= margin + 1 or y0 <= margin + 1 or x1 >= w - margin - 2 or y1 >= h - margin - 2:
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

"""Find word-sized clusters of marker ink in the rectified (top-down) image.

We look for ink, not paper: thin dark strokes whose surroundings are light.
That works for white scraps on a white sheet, and it ignores hands, sleeves
and soft shadows because those are not thin strokes.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from . import PX_PER_MM, mm, odd

STROKE_SPAN_MM = 14.0  # dark features thinner than this count as strokes
INK_RATIO = 0.62  # a stroke pixel is darker than this fraction of its surroundings
PAPER_MIN_LEVEL = 85  # surroundings must be at least this bright to be paper
GROUP_MM = 9.0  # letters closer than this join into one word
EDGE_MARGIN_MM = 5.0
WORD_LONG_MM = (16.0, 190.0)
WORD_SHORT_MM = (7.0, 75.0)
MIN_INK_MM2 = 35.0


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


def detect(rect_bgr: np.ndarray) -> DetectResult:
    gray = cv2.cvtColor(rect_bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    # Local background: closing removes anything dark and thin (strokes), leaving
    # the paper level and any large dark objects.
    span = odd(mm(STROKE_SPAN_MM))
    background = cv2.morphologyEx(gray, cv2.MORPH_CLOSE, np.ones((span, span), np.uint8))
    background = cv2.blur(background, (odd(span // 2), odd(span // 2)))
    ratio = (gray.astype(np.float32) + 1.0) / (background.astype(np.float32) + 1.0)
    ink = ((ratio < INK_RATIO) & (background > PAPER_MIN_LEVEL)).astype(np.uint8) * 255
    ink = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))

    margin = mm(EDGE_MARGIN_MM)
    ink[:margin, :] = 0
    ink[-margin:, :] = 0
    ink[:, :margin] = 0
    ink[:, -margin:] = 0

    # Occluders: big regions that are clearly not paper (dark, or strongly coloured).
    paper_level = float(np.percentile(background, 70))
    hsv = cv2.cvtColor(rect_bgr, cv2.COLOR_BGR2HSV)
    saturation = cv2.morphologyEx(hsv[:, :, 1], cv2.MORPH_OPEN, np.ones((span, span), np.uint8))
    paper_saturation = float(np.median(saturation))  # warm room light tints the paper itself
    occluder = (
        (background < 0.68 * paper_level) | (saturation > paper_saturation + 55)
    ).astype(np.uint8) * 255
    k = odd(mm(10.0))
    occluder = cv2.morphologyEx(occluder, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))

    # Ink that sits on an occluder (creases between fingers, sleeve seams) is not a card.
    grown = cv2.dilate(occluder, np.ones((odd(mm(4.0)), odd(mm(4.0))), np.uint8))
    ink[grown > 0] = 0

    group = odd(mm(GROUP_MM))
    joined = cv2.dilate(ink, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (group, group)))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(joined, connectivity=8)

    detections: list[Detection] = []
    for label in range(1, count):
        x0, y0, bw, bh, _ = stats[label]
        if x0 <= 1 or y0 <= 1 or x0 + bw >= w - 1 or y0 + bh >= h - 1:
            continue  # runs off the play area: an arm, not a card
        region = (labels[y0 : y0 + bh, x0 : x0 + bw] == label) & (ink[y0 : y0 + bh, x0 : x0 + bw] > 0)
        ys, xs = np.nonzero(region)
        if len(xs) < MIN_INK_MM2 * PX_PER_MM * PX_PER_MM:
            continue
        points = np.column_stack((xs + x0, ys + y0)).astype(np.float32)
        (cx, cy), (rw, rh), angle = cv2.minAreaRect(points)
        if rw < rh:
            rw, rh = rh, rw
            angle += 90.0
        long_mm, short_mm = rw / PX_PER_MM, rh / PX_PER_MM
        if not (WORD_LONG_MM[0] <= long_mm <= WORD_LONG_MM[1]):
            continue
        if not (WORD_SHORT_MM[0] <= short_mm <= WORD_SHORT_MM[1]):
            continue
        fill = len(xs) / max(rw * rh, 1.0)
        if not (0.04 <= fill <= 0.7):
            continue
        detections.append(
            Detection(
                x=float(cx), y=float(cy), angle=float(angle), long=float(rw), short=float(rh),
                ink=len(xs) / (PX_PER_MM * PX_PER_MM),
            )
        )
    return DetectResult(detections=detections, ink=ink, occluder=occluder)

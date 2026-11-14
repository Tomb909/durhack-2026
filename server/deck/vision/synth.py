"""Synthetic camera frames: a bordered sheet with word scraps, seen at an angle.

Used by tests and by `--source synth` so the whole pipeline can run with no
phone. The lettering is a plain computer font, so this checks the plumbing,
not real handwriting.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

SHEET_PX_PER_MM = 4.0
PAPER_MARGIN_MM = 18.0
BORDER_MM = 5.0
PLAY_W_MM, PLAY_H_MM = 420.0 - 2 * (PAPER_MARGIN_MM + BORDER_MM), 297.0 - 2 * (PAPER_MARGIN_MM + BORDER_MM)


@dataclass
class Scrap:
    word: str
    x: float  # 0..1 across the play area
    y: float  # 0..1 down the play area
    angle: float = 0.0  # degrees
    letter_mm: float = 18.0
    pad_mm: float = 11.0  # blank margin around the word


def _scrap_image(scrap: Scrap) -> tuple[np.ndarray, np.ndarray]:
    """A white scrap with the word on it, rotated; returns (image, mask)."""
    s = SHEET_PX_PER_MM
    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = scrap.letter_mm * s / 22.0  # Hershey capitals are ~22 px tall at scale 1
    thickness = max(2, int(round(2.6 * s)))
    (tw, th), _ = cv2.getTextSize(scrap.word, font, scale, thickness)
    pad = int(scrap.pad_mm * s)
    w, h = tw + 2 * pad, th + 2 * pad
    img = np.full((h, w, 3), 250, np.uint8)
    cv2.putText(img, scrap.word, (pad, pad + th), font, scale, (25, 25, 25), thickness, cv2.LINE_AA)
    cv2.rectangle(img, (0, 0), (w - 1, h - 1), (205, 205, 205), 2)  # faint paper edge
    diag = int(np.ceil(np.hypot(w, h))) + 4
    canvas = np.zeros((diag, diag, 3), np.uint8)
    mask = np.zeros((diag, diag), np.uint8)
    ox, oy = (diag - w) // 2, (diag - h) // 2
    canvas[oy : oy + h, ox : ox + w] = img
    mask[oy : oy + h, ox : ox + w] = 255
    m = cv2.getRotationMatrix2D((diag / 2, diag / 2), scrap.angle, 1.0)
    canvas = cv2.warpAffine(canvas, m, (diag, diag), flags=cv2.INTER_LINEAR)
    mask = cv2.warpAffine(mask, m, (diag, diag), flags=cv2.INTER_LINEAR)
    return canvas, mask


def border_line(border: str) -> np.ndarray | None:
    """Centre line of a non-rectangular border, sheet pixels (None for the rectangle).

    "circle": as wide as the sheet allows. "blob": an irregular, wider-than-tall
    shape with bulges and dents.
    """
    if border == "rect":
        return None
    s = SHEET_PX_PER_MM
    w, h = 420 * s, 297 * s
    reach = PAPER_MARGIN_MM * s + BORDER_MM * s / 2  # keep the line this far from the sheet edge
    theta = np.linspace(0, 2 * np.pi, 360, endpoint=False)
    if border == "circle":
        r = h / 2 - reach
        x, y = r * np.cos(theta), r * np.sin(theta)
    elif border == "blob":
        r = 1 + 0.16 * np.sin(3 * theta + 0.4) + 0.08 * np.cos(5 * theta)
        x, y = r * np.cos(theta), r * np.sin(theta)
        x *= (w / 2 - reach) / np.abs(x).max()
        y *= (h / 2 - reach) / np.abs(y).max()
    else:
        raise ValueError(f"unknown border {border!r}")
    return np.column_stack((x + w / 2, y + h / 2)).astype(np.float32)


def inner_box(border: str = "rect") -> tuple[float, float, float, float]:
    """The play area's bounding box on the sheet (x, y, w, h in sheet pixels): scrap positions are fractions of it."""
    s = SHEET_PX_PER_MM
    w, h = int(420 * s), int(297 * s)
    m0, b = int(PAPER_MARGIN_MM * s), int(BORDER_MM * s)
    line = border_line(border)
    if line is None:
        return m0 + b, m0 + b, w - 2 * (m0 + b), h - 2 * (m0 + b)
    hole = np.zeros((h, w), np.uint8)
    pts = np.round(line).astype(np.int32)
    cv2.fillPoly(hole, [pts], 255)
    cv2.polylines(hole, [pts], True, 0, b, cv2.LINE_AA)
    ys, xs = np.nonzero(hole > 127)
    return float(xs.min()), float(ys.min()), float(xs.max() - xs.min()), float(ys.max() - ys.min())


def render_sheet(scraps: list[Scrap], border: str = "rect") -> np.ndarray:
    """Top-down image of the A3 sheet with its border and scraps."""
    s = SHEET_PX_PER_MM
    w, h = int(420 * s), int(297 * s)
    sheet = np.full((h, w, 3), 238, np.uint8)
    m0 = int(PAPER_MARGIN_MM * s)
    b = int(BORDER_MM * s)
    line = border_line(border)
    if line is None:
        cv2.rectangle(sheet, (m0, m0), (w - m0, h - m0), (20, 20, 20), -1)
        cv2.rectangle(sheet, (m0 + b, m0 + b), (w - m0 - b, h - m0 - b), (238, 238, 238), -1)
    else:
        cv2.polylines(sheet, [np.round(line).astype(np.int32)], True, (20, 20, 20), b, cv2.LINE_AA)
    inner_x, inner_y, inner_w, inner_h = inner_box(border)
    for scrap in scraps:
        img, mask = _scrap_image(scrap)
        cx = inner_x + scrap.x * inner_w
        cy = inner_y + scrap.y * inner_h
        x0, y0 = int(cx - img.shape[1] / 2), int(cy - img.shape[0] / 2)
        x1, y1 = x0 + img.shape[1], y0 + img.shape[0]
        sx0, sy0 = max(0, -x0), max(0, -y0)
        x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, w), min(y1, h)
        if x1 <= x0 or y1 <= y0:
            continue
        part = img[sy0 : sy0 + (y1 - y0), sx0 : sx0 + (x1 - x0)]
        alpha = (mask[sy0 : sy0 + (y1 - y0), sx0 : sx0 + (x1 - x0)].astype(np.float32) / 255.0)[..., None]
        sheet[y0:y1, x0:x1] = (alpha * part + (1 - alpha) * sheet[y0:y1, x0:x1]).astype(np.uint8)
    return sheet


def render_frame(
    scraps: list[Scrap],
    size: tuple[int, int] = (1920, 1080),
    tilt: float = 0.12,
    shift: tuple[float, float] = (0.0, 0.0),
    hand: tuple[float, float] | None = None,
    seed: int = 0,
    shadow: float | None = None,
    border: str = "rect",
) -> np.ndarray:
    """A camera frame: the sheet on a wooden table, seen at a slight angle.

    `tilt` narrows the far edge (perspective). `shift` moves the sheet in the
    frame (a nudged phone). `shadow` dims the left half of the picture to that
    fraction of its brightness, with a soft edge (the phone's own shadow). `hand` puts an arm reaching to that play-area
    position (0..1, 0..1). `border` is the drawn play area: "rect", "circle" or "blob".
    """
    rng = np.random.default_rng(seed)
    fw, fh = size
    sheet = render_sheet(scraps, border)
    sh, sw = sheet.shape[:2]
    frame = np.empty((fh, fw, 3), np.uint8)
    frame[:] = (70, 105, 140)  # BGR wood
    grain = rng.normal(0, 6, (fh // 8, fw // 2, 1)).astype(np.float32)
    grain = cv2.resize(grain, (fw, fh), interpolation=cv2.INTER_CUBIC)[..., None]
    frame = np.clip(frame.astype(np.float32) + grain, 0, 255).astype(np.uint8)

    margin_x, margin_y = 0.09 * fw, 0.07 * fh
    dx, dy = shift[0] * fw, shift[1] * fh
    inset = tilt * fw * 0.5
    target = np.array(
        [[margin_x + inset + dx, margin_y + dy], [fw - margin_x - inset + dx, margin_y + dy],
         [fw - margin_x + dx, fh - margin_y + dy], [margin_x + dx, fh - margin_y + dy]],
        dtype=np.float32,
    )
    source = np.array([[0, 0], [sw, 0], [sw, sh], [0, sh]], dtype=np.float32)
    m = cv2.getPerspectiveTransform(source, target)
    warped = cv2.warpPerspective(sheet, m, (fw, fh), flags=cv2.INTER_AREA)
    mask = cv2.warpPerspective(np.full((sh, sw), 255, np.uint8), m, (fw, fh))
    frame[mask > 127] = warped[mask > 127]

    if hand is not None:
        ix, iy, iw, ih = inner_box(border)
        tip_sheet = np.array([[[ix + hand[0] * iw, iy + hand[1] * ih]]], dtype=np.float32)
        tip = cv2.perspectiveTransform(tip_sheet, m).reshape(2)
        base = np.array([tip[0] + 0.1 * fw, fh + 40.0])
        cv2.line(frame, tuple(int(v) for v in base), tuple(int(v) for v in tip), (40, 40, 45), 150)  # sleeve
        mid = base + 0.72 * (tip - base)
        cv2.line(frame, tuple(int(v) for v in mid), tuple(int(v) for v in tip), (120, 150, 205), 120)  # hand
        cv2.circle(frame, tuple(int(v) for v in tip), 70, (120, 150, 205), -1)

    if shadow is not None:
        ramp = np.clip((np.arange(fw, dtype=np.float32) - 0.50 * fw) / (0.06 * fw), 0.0, 1.0)
        frame = (frame.astype(np.float32) * (shadow + (1.0 - shadow) * ramp)[None, :, None]).astype(np.uint8)

    # Uneven lighting and a little sensor noise.
    gx = np.linspace(0.82, 1.06, fw, dtype=np.float32)[None, :, None]
    gy = np.linspace(1.04, 0.9, fh, dtype=np.float32)[:, None, None]
    lit = frame.astype(np.float32) * gx * gy + rng.normal(0, 2.0, frame.shape).astype(np.float32)
    return np.clip(lit, 0, 255).astype(np.uint8)

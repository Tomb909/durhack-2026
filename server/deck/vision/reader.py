"""Read the word on a scrap and match it to a known card.

Reading is open-vocabulary OCR (so an unknown word still comes back as text,
which a later AI-card feature can use), followed by a forgiving match against
the words of the current card set.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from rapidfuzz.distance import Levenshtein

from . import PX_PER_MM
from .detect import Detection

CROP_HEIGHT = 64
PAD_MM = 4.0
# Characters OCR commonly returns in place of capital letters.
LOOKALIKES = str.maketrans({"0": "O", "1": "I", "5": "S", "8": "B", "6": "G", "2": "Z", "4": "A", "7": "T", "3": "E", "|": "I", "!": "I", "$": "S", "@": "A"})

CARDS_JSON = Path(__file__).resolve().parents[3] / "web" / "src" / "cards" / "cards.json"


def load_vocabulary(path: Path = CARDS_JSON) -> dict[str, str]:
    """Map each written word (and alias) to its card id."""
    cards = json.loads(path.read_text(encoding="utf-8"))
    vocabulary: dict[str, str] = {}
    for card in cards:
        for word in [card["word"], *card.get("aliases", [])]:
            vocabulary[normalise(word)] = card["id"]
    return vocabulary


def normalise(text: str) -> str:
    return re.sub(r"[^A-Z]", "", text.upper().translate(LOOKALIKES))


def allowed_edits(word: str) -> int:
    if len(word) <= 2:
        return 0
    if len(word) <= 5:
        return 1
    if len(word) <= 8:
        return 2
    return 3


@dataclass
class Reading:
    card: str | None  # matched card id, or None
    text: str  # normalised text as read (best orientation)
    confidence: float  # OCR confidence 0..1
    edits: int  # edit distance to the matched word (0 = exact)
    turned: int  # rotation (degrees) that gave this reading

    @property
    def quality(self) -> float:
        """Higher is a more trustworthy reading."""
        if self.card is None:
            return 0.0
        return self.confidence / (1.0 + self.edits)


def match(text: str, vocabulary: dict[str, str]) -> tuple[str | None, int]:
    """Return (card id, edit distance) for the closest word, or (None, 99)."""
    text = normalise(text)
    if not text:
        return None, 99
    scored = sorted((Levenshtein.distance(text, word), word) for word in vocabulary)
    best_distance, best_word = scored[0]
    if best_distance > allowed_edits(best_word):
        return None, 99
    # Ambiguous between two different cards (e.g. LICE: ICE or LIFE?) -> no match.
    for distance, word in scored[1:]:
        if distance == best_distance and vocabulary[word] != vocabulary[best_word]:
            return None, 99
    return vocabulary[best_word], best_distance


def crop_word(image: np.ndarray, to_image: np.ndarray, det: Detection) -> np.ndarray:
    """Cut the word out of the full-resolution camera image, upright along its long axis.

    `to_image` maps rectified pixels to camera pixels (the inverse homography).
    """
    pad = PAD_MM * PX_PER_MM
    # Build the corners explicitly so the crop's x axis always runs along the word.
    theta = np.deg2rad(det.angle)
    ux, uy = np.cos(theta), np.sin(theta)  # along the word
    vx, vy = -uy, ux  # across the word
    half_l, half_s = det.long / 2 + pad, det.short / 2 + pad
    centre = np.array([det.x, det.y])
    u, v = np.array([ux, uy]), np.array([vx, vy])
    box = np.array(
        [centre - half_l * u - half_s * v, centre + half_l * u - half_s * v,
         centre + half_l * u + half_s * v, centre - half_l * u + half_s * v],
        dtype=np.float32,
    )
    source = cv2.perspectiveTransform(box.reshape(1, 4, 2), to_image).reshape(4, 2).astype(np.float32)
    width = int(np.clip(CROP_HEIGHT * half_l / max(half_s, 1.0), CROP_HEIGHT, CROP_HEIGHT * 10))
    target = np.array([[0, 0], [width, 0], [width, CROP_HEIGHT], [0, CROP_HEIGHT]], dtype=np.float32)
    transform = cv2.getPerspectiveTransform(source, target)
    return cv2.warpPerspective(image, transform, (width, CROP_HEIGHT), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


class Reader:
    def __init__(self, vocabulary: dict[str, str] | None = None) -> None:
        from rapidocr import RapidOCR  # slow import; keep it out of module load

        logging.getLogger("RapidOCR").setLevel(logging.ERROR)
        self.vocabulary = vocabulary if vocabulary is not None else load_vocabulary()
        self.engine = RapidOCR()
        logging.getLogger("RapidOCR").setLevel(logging.ERROR)
        # First call loads the model; do it now rather than on the first card.
        self.read_text(np.full((CROP_HEIGHT, CROP_HEIGHT * 3, 3), 255, np.uint8))

    def read_text(self, crop: np.ndarray) -> tuple[str, float]:
        result = self.engine(crop, use_det=False, use_cls=False, use_rec=True)
        texts = getattr(result, "txts", None) or ()
        scores = getattr(result, "scores", None) or ()
        if not texts:
            return "", 0.0
        return str(texts[0]), float(scores[0])

    def read(self, crop: np.ndarray, squarish: bool = False) -> Reading:
        """Read an upright-or-upside-down crop, trying each plausible rotation."""
        best = Reading(card=None, text="", confidence=0.0, edits=99, turned=0)
        rotations = [0, 180, 90, 270] if squarish else [0, 180]
        for turned in rotations:
            view = crop
            if turned == 180:
                view = cv2.rotate(crop, cv2.ROTATE_180)
            elif turned == 90:
                view = cv2.rotate(crop, cv2.ROTATE_90_CLOCKWISE)
            elif turned == 270:
                view = cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)
            text, confidence = self.read_text(view)
            card, edits = match(text, self.vocabulary)
            reading = Reading(card=card, text=normalise(text), confidence=confidence, edits=edits, turned=turned)
            if reading.quality > best.quality or (
                best.card is None and reading.card is None and confidence > best.confidence
            ):
                best = reading
        return best

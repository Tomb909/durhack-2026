"""Follow scraps over time.

A scrap's word is read only when it first appears. After that we just follow
the ink. Cards hidden by a hand are held in place; a card is only removed when
we can see clear paper where it used to be.

A confirmed card also stays put against the small frame-to-frame differences
of a still camera: its position only changes when the ink has really moved,
and a word whose letters are grouped differently for a moment (split in two,
or not found as a word at all) is still the same card in the same place.

A word that is no known card, read the same way several times over, becomes a
card too: the page has the model make a card for it (see deck/words.py).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Callable

import cv2
import numpy as np

from . import PX_PER_MM, RECT_H, RECT_W
from .detect import Detection
from .reader import Reading

GATE_MM = 70.0  # a scrap cannot move further than this between frames
REMOVE_AFTER_CLEAR = 0.45  # seconds of visibly empty paper before a card is removed
REMOVE_AFTER_MISSES = 3  # ...and at least this many frames in a row (matters on a slow link)
CANDIDATE_REMOVE_AFTER = 0.25
HIDDEN_LIMIT = 30.0  # give up on a covered card after this long
VOTES_TO_CONFIRM = 2
SURE_CONFIDENCE = 0.9  # one exact reading this confident confirms immediately
MAX_READS_PER_FRAME = 4
SLOW_READ_AFTER = 10  # after this many failed reads, retry less often
SLOW_READ_INTERVAL = 0.5
POSITION_BLEND = 0.6
VERIFY_INTERVAL = 3.0  # re-read a known card this often, in case two scraps swapped
WIND_VERIFY_INTERVAL = 0.5  # also keep a rotated WIND card's arrow direction current
VERIFY_SIZE_CHANGE = 0.35  # ...or at once if its word suddenly changes size
DISSENT_TO_SWITCH = 2
# A still camera gives every word a slightly different centre and tilt on each frame.
STILL_MM = 1.5  # a confirmed card moves only when its word is seen further than this from where we hold it
STILL_DEGREES = 4.0  # ...or tilted by more than this
SQUARISH = 1.3  # long / short below this: the word's direction cannot be told from its outline
# The same ink can be grouped differently from frame to frame (a wide gap between letters,
# an arrow beside the word). A confirmed card keeps its place and size through that.
SAME_LONG = 0.2  # a word whose length differs by more than this share is a different grouping...
SAME_SHORT = 0.35  # ...or whose height does
REGROUP_SECONDS = 1.5  # a different grouping must last this long, with the card's own ink gone, before the card takes it on
INK_REMAINS = 0.5  # with no word found, this share of the card's ink still in place means it is still there
INK_PAD_MM = 2.0
# A word that matches no card is made into one, once it has been read the same way for a while.
# (Text that changes from read to read is a hand in the way, or not writing at all.)
WORD_MIN_LETTERS = 3
WORD_CONFIDENCE = 0.8  # each of those reads must be at least this sure
WORD_READS = 3  # this many reads in a row must agree...
WORD_SECONDS = 0.8  # ...over at least this long


@dataclass
class Track:
    id: int
    x: float  # rectified pixels
    y: float
    angle: float
    long: float
    short: float
    first_seen: float
    last_seen: float
    card: str | None = None  # set once confirmed
    visible: bool = True
    text: str = ""  # latest reading, for display
    confidence: float = 0.0
    votes: Counter = field(default_factory=Counter)
    reads: int = 0
    last_read: float = 0.0
    clear_since: float | None = None
    misses: int = 0  # frames in a row with no matching ink
    ref_long: float = 0.0  # word length when the identity was confirmed
    last_verify: float = 0.0
    dissent: Counter = field(default_factory=Counter)
    turned: int = 0  # clockwise correction used to read the word, in degrees
    ink: float = 0.0  # ink area of the word, mm^2
    regroup_since: float | None = None  # when its ink started being grouped differently
    word: str = ""  # for a card made from a word that is no known card: the word as written
    run_text: str = ""  # the unknown text its latest reads agree on
    run: int = 0  # how many reads in a row have given that text
    run_since: float = 0.0

    def as_detection(self) -> Detection:
        return Detection(self.x, self.y, self.angle, self.long, self.short, 0.0)


class Tracker:
    def __init__(self) -> None:
        self.tracks: list[Track] = []
        self._next_id = 1
        self.size: tuple[int, int] = (RECT_W, RECT_H)  # rectified image the positions are measured in
        self.make_words = True  # False: a word that is no known card stays a candidate ("?")

    def reset(self) -> None:
        self.tracks.clear()

    def update(
        self,
        detections: list[Detection],
        occluder: np.ndarray,
        now: float,
        read: Callable[[Detection], Reading] | None,
        ink: np.ndarray | None = None,
    ) -> None:
        """`ink`: the mask of ink pixels the detections came from (rectified image), if available."""
        gate = GATE_MM * PX_PER_MM

        # --- match detections to existing tracks, closest pairs first
        pairs = []
        for ti, track in enumerate(self.tracks):
            for di, det in enumerate(detections):
                distance = float(np.hypot(track.x - det.x, track.y - det.y))
                if distance <= gate:
                    # Prefer a word of the same length: stops two scraps that
                    # brush past each other from swapping identities.
                    pairs.append((distance + 0.5 * abs(track.long - det.long), ti, di))
        pairs.sort()
        used_tracks: set[int] = set()
        used_detections: set[int] = set()
        matched: dict[int, Detection] = {}
        for _, ti, di in pairs:
            if ti in used_tracks or di in used_detections:
                continue
            used_tracks.add(ti)
            used_detections.add(di)
            matched[ti] = detections[di]

        for ti, track in enumerate(self.tracks):
            det = matched.get(ti)
            if det is not None:
                self._follow(track, det, now, ink)
                track.last_seen = now
                track.visible = True
                track.clear_since = None
                track.misses = 0
            else:
                track.visible = False
                track.misses += 1
                if track.card is not None and ink is not None and self._ink_remains(track, ink):
                    # No word was made of it this frame, but its ink is all still there.
                    track.last_seen = now
                    track.visible = True
                    track.clear_since = None
                    track.misses = 0

        # --- new scraps
        for di, det in enumerate(detections):
            if di not in used_detections:
                self.tracks.append(
                    Track(id=self._next_id, x=det.x, y=det.y, angle=det.angle, long=det.long,
                          short=det.short, first_seen=now, last_seen=now, ink=det.ink)
                )
                self._next_id += 1

        # --- read words for scraps that have no identity yet
        if read is not None:
            budget = MAX_READS_PER_FRAME
            waiting = [t for t in self.tracks if t.card is None and t.visible]
            waiting.sort(key=lambda t: t.reads)
            for track in waiting:
                if budget <= 0:
                    break
                if track.reads >= SLOW_READ_AFTER and now - track.last_read < SLOW_READ_INTERVAL:
                    continue
                budget -= 1
                reading = read(track.as_detection())
                track.reads += 1
                track.last_read = now
                track.text, track.confidence = reading.text, reading.confidence
                if reading.card is None:
                    self._count_unknown(track, reading, now)
                    continue
                track.run = 0
                track.votes[reading.card] += 1
                sure = reading.edits == 0 and reading.confidence >= SURE_CONFIDENCE
                if sure or track.votes[reading.card] >= VOTES_TO_CONFIRM:
                    self._confirm(track, reading.card)
                    track.turned = reading.turned
                    track.ref_long, track.last_verify = track.long, now

            # Occasionally double-check known cards (cheap), so a mix-up heals itself.
            for track in self.tracks:
                if budget <= 0:
                    break
                if track.card is None or not track.visible:
                    continue
                resized = abs(track.long - track.ref_long) > VERIFY_SIZE_CHANGE * max(track.ref_long, 1.0)
                verify_interval = 0.4 if resized else WIND_VERIFY_INTERVAL if track.card == "wind" else VERIFY_INTERVAL
                if now - track.last_verify < verify_interval:
                    continue
                budget -= 1
                track.last_verify = now
                reading = read(track.as_detection())
                # A card made from a word is known by its text; it may turn out to be another such word.
                claim, word = reading.card, ""
                if claim is None and track.word and self._is_word(reading):
                    claim, word = reading.text.lower(), reading.phrase or reading.text
                if claim == track.card:
                    track.dissent.clear()
                    track.ref_long = track.long
                    track.turned = reading.turned
                elif word or (reading.card is not None and reading.edits == 0 and reading.confidence >= 0.8):
                    track.dissent[claim] += 1
                    if track.dissent[claim] >= DISSENT_TO_SWITCH:
                        # It really is a different card: retire the old identity, start a new one.
                        track.card, track.word = claim, word
                        track.id = self._next_id
                        self._next_id += 1
                        track.dissent.clear()
                        track.ref_long = track.long
                        track.turned = reading.turned

        # --- decide what happens to scraps we cannot see
        survivors: list[Track] = []
        for track in self.tracks:
            if track.visible:
                survivors.append(track)
                continue
            if self._is_covered(track, occluder):
                track.clear_since = None
                if now - track.last_seen < HIDDEN_LIMIT:
                    survivors.append(track)
                continue
            if track.clear_since is None:
                track.clear_since = now
            limit = REMOVE_AFTER_CLEAR if track.card else CANDIDATE_REMOVE_AFTER
            if now - track.clear_since < limit or track.misses < REMOVE_AFTER_MISSES:
                survivors.append(track)
        self.tracks = survivors

    @staticmethod
    def _follow(track: Track, det: Detection, now: float, ink: np.ndarray | None) -> None:
        """Move a scrap to where its word was just seen."""
        # The word's long axis has no inherent sign. Keep its axis continuous
        # across the minAreaRect 180-degree wrap; OCR supplies the sign.
        turn = (det.angle - track.angle + 90.0) % 180.0 - 90.0
        if track.card is None or not track.visible:
            # Still being read, or back from under a hand: take it as seen.
            blend = POSITION_BLEND if track.visible else 1.0
            track.x += blend * (det.x - track.x)
            track.y += blend * (det.y - track.y)
            track.angle += turn
            track.long, track.short, track.ink = det.long, det.short, det.ink
            track.regroup_since = None
            return
        distance = float(np.hypot(det.x - track.x, det.y - track.y))
        same_size = (
            abs(det.long - track.long) <= SAME_LONG * track.long
            and abs(det.short - track.short) <= SAME_SHORT * track.short + PX_PER_MM
        )
        if not same_size and distance < 0.75 * track.long:
            # Part of the word, or the word joined to something beside it: the card has not moved.
            if track.regroup_since is None:
                track.regroup_since = now
            if now - track.regroup_since < REGROUP_SECONDS or (ink is not None and Tracker._ink_remains(track, ink)):
                return
            track.x, track.y = det.x, det.y  # it has stayed like this: this is the word now
            track.angle += turn
        else:
            if distance > STILL_MM * PX_PER_MM:
                track.x += POSITION_BLEND * (det.x - track.x)
                track.y += POSITION_BLEND * (det.y - track.y)
            if abs(turn) > STILL_DEGREES and det.long >= SQUARISH * det.short:
                track.angle += turn
        track.regroup_since = None
        track.long, track.short, track.ink = det.long, det.short, det.ink

    @staticmethod
    def _ink_remains(track: Track, ink: np.ndarray) -> bool:
        """Is most of this card's ink still where the card is, though no word was found there?"""
        pad = 2 * INK_PAD_MM * PX_PER_MM
        box = cv2.boxPoints(((track.x, track.y), (track.long + pad, track.short + pad), track.angle))
        h, w = ink.shape[:2]
        x0, y0 = np.clip(np.floor(box.min(axis=0)).astype(int), 0, [w - 1, h - 1])
        x1, y1 = np.clip(np.ceil(box.max(axis=0)).astype(int) + 1, 1, [w, h])
        if x1 <= x0 or y1 <= y0:
            return False
        under = np.zeros((y1 - y0, x1 - x0), np.uint8)
        cv2.fillConvexPoly(under, np.round(box - [x0, y0]).astype(np.int32), 255)
        found = np.count_nonzero(ink[y0:y1, x0:x1][under > 0]) / (PX_PER_MM * PX_PER_MM)
        return track.ink > 0 and found >= INK_REMAINS * track.ink

    @staticmethod
    def _is_word(reading: Reading) -> bool:
        """Could this reading, which matched no card, be a word to make a card from?"""
        return len(reading.text) >= WORD_MIN_LETTERS and reading.confidence >= WORD_CONFIDENCE

    def _count_unknown(self, track: Track, reading: Reading, now: float) -> None:
        """A read that matched no card. The same text several times over is a word of its own."""
        if not self.make_words or not self._is_word(reading):
            track.run = 0
            return
        if track.run == 0 or reading.text != track.run_text:
            track.run_text, track.run, track.run_since = reading.text, 0, now
        track.run += 1
        if track.run < WORD_READS or now - track.run_since < WORD_SECONDS:
            return
        # A piece of a known card's word (its letters grouped in two for a moment) is not a new word.
        if self._is_fragment_of_known(track, [t for t in self.tracks if t.card is not None]):
            return
        self._confirm(track, reading.text.lower())
        track.word = reading.phrase or reading.text
        track.turned = reading.turned
        track.ref_long, track.last_verify = track.long, now

    def _confirm(self, track: Track, card: str) -> None:
        """Give a scrap its identity; if a hidden card of the same word exists, it has moved."""
        hidden = [t for t in self.tracks if t is not track and t.card == card and not t.visible]
        if hidden:
            old = min(hidden, key=lambda t: np.hypot(t.x - track.x, t.y - track.y))
            # Keep the old identity (so the world glides) at the new place.
            track.id = old.id
            track.first_seen = old.first_seen
            self.tracks = [t for t in self.tracks if t is not old]
        track.card = card

    @staticmethod
    def _is_covered(track: Track, occluder: np.ndarray) -> bool:
        """Is something (a hand, a sleeve) over where this scrap was?"""
        half = int(max(track.long, track.short) / 2)
        x0, x1 = int(track.x) - half, int(track.x) + half
        y0, y1 = int(track.y) - half, int(track.y) + half
        h, w = occluder.shape[:2]
        if x0 < 0 or y0 < 0 or x1 >= w or y1 >= h:
            # Partly outside the play area: treat anything touching it as covering.
            x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, w - 1), min(y1, h - 1)
        if x1 <= x0 or y1 <= y0:
            return False
        patch = occluder[y0:y1, x0:x1]
        return float(np.count_nonzero(patch)) / patch.size > 0.12

    @staticmethod
    def _bounds(track: Track) -> tuple[float, float, float, float]:
        theta = np.deg2rad(track.angle)
        half_long, half_short = track.long / 2, track.short / 2
        half_x = abs(float(np.cos(theta))) * half_long + abs(float(np.sin(theta))) * half_short
        half_y = abs(float(np.sin(theta))) * half_long + abs(float(np.cos(theta))) * half_short
        return track.x - half_x, track.y - half_y, track.x + half_x, track.y + half_y

    @classmethod
    def _is_fragment_of_known(cls, candidate: Track, known_cards: list[Track]) -> bool:
        x0, y0, x1, y1 = cls._bounds(candidate)
        area = (x1 - x0) * (y1 - y0)
        if area <= 0:
            return False
        for known in known_cards:
            kx0, ky0, kx1, ky1 = cls._bounds(known)
            known_area = (kx1 - kx0) * (ky1 - ky0)
            if area >= known_area * 0.55:
                continue
            overlap = max(0.0, min(x1, kx1) - max(x0, kx0)) * max(0.0, min(y1, ky1) - max(y0, ky0))
            if overlap / area >= 0.75:
                return True
        return False

    def display_tracks(self) -> list[Track]:
        known_cards = [track for track in self.tracks if track.card is not None]
        return [
            track for track in self.tracks
            if track.card is not None or not self._is_fragment_of_known(track, known_cards)
        ]

    # --- output -------------------------------------------------------------

    def resize(self, size: tuple[int, int]) -> None:
        """The rectified image changed size (the play area's proportions changed): keep cards in place."""
        if size == self.size:
            return
        sx, sy = size[0] / self.size[0], size[1] / self.size[1]
        for t in self.tracks:
            t.x *= sx
            t.y *= sy
        self.size = size

    def cards(self) -> list[dict]:
        w, h = self.size
        return [
            {
                "id": t.id,
                "card": t.card,
                "x": round(t.x / w, 4),
                "y": round(t.y / h, 4),
                "angle": round(float(np.deg2rad(t.angle + (180 if t.turned == 180 else 0))), 5),
                "visible": t.visible,
                # A word that is no known card: the page has a card made for it.
                **({"word": t.word} if t.word else {}),
            }
            for t in self.tracks
            if t.card is not None
        ]

    def candidates(self) -> list[dict]:
        w, h = self.size
        return [
            {"id": t.id, "x": round(t.x / w, 4), "y": round(t.y / h, 4), "text": t.text,
             "confidence": round(t.confidence, 3), "reads": t.reads}
            for t in self.display_tracks()
            if t.card is None
        ]

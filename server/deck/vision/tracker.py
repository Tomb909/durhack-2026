"""Follow scraps over time.

A scrap's word is read only when it first appears. After that we just follow
the ink. Cards hidden by a hand are held in place; a card is only removed when
we can see clear paper where it used to be.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Callable

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
VERIFY_SIZE_CHANGE = 0.35  # ...or at once if its word suddenly changes size
DISSENT_TO_SWITCH = 2


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

    def as_detection(self) -> Detection:
        return Detection(self.x, self.y, self.angle, self.long, self.short, 0.0)


class Tracker:
    def __init__(self) -> None:
        self.tracks: list[Track] = []
        self._next_id = 1
        self.size: tuple[int, int] = (RECT_W, RECT_H)  # rectified image the positions are measured in

    def reset(self) -> None:
        self.tracks.clear()

    def update(
        self,
        detections: list[Detection],
        occluder: np.ndarray,
        now: float,
        read: Callable[[Detection], Reading] | None,
    ) -> None:
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
                blend = POSITION_BLEND if track.visible else 1.0
                track.x += blend * (det.x - track.x)
                track.y += blend * (det.y - track.y)
                track.angle, track.long, track.short = det.angle, det.long, det.short
                track.last_seen = now
                track.visible = True
                track.clear_since = None
                track.misses = 0
            else:
                track.visible = False
                track.misses += 1

        # --- new scraps
        for di, det in enumerate(detections):
            if di not in used_detections:
                self.tracks.append(
                    Track(id=self._next_id, x=det.x, y=det.y, angle=det.angle, long=det.long,
                          short=det.short, first_seen=now, last_seen=now)
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
                    continue
                track.votes[reading.card] += 1
                sure = reading.edits == 0 and reading.confidence >= SURE_CONFIDENCE
                if sure or track.votes[reading.card] >= VOTES_TO_CONFIRM:
                    self._confirm(track, reading.card)
                    track.ref_long, track.last_verify = track.long, now

            # Occasionally double-check known cards (cheap), so a mix-up heals itself.
            for track in self.tracks:
                if budget <= 0:
                    break
                if track.card is None or not track.visible:
                    continue
                resized = abs(track.long - track.ref_long) > VERIFY_SIZE_CHANGE * max(track.ref_long, 1.0)
                if now - track.last_verify < (0.4 if resized else VERIFY_INTERVAL):
                    continue
                budget -= 1
                track.last_verify = now
                reading = read(track.as_detection())
                if reading.card == track.card:
                    track.dissent.clear()
                    track.ref_long = track.long
                elif reading.card is not None and reading.edits == 0 and reading.confidence >= 0.8:
                    track.dissent[reading.card] += 1
                    if track.dissent[reading.card] >= DISSENT_TO_SWITCH:
                        # It really is a different card: retire the old identity, start a new one.
                        track.card = reading.card
                        track.id = self._next_id
                        self._next_id += 1
                        track.dissent.clear()
                        track.ref_long = track.long

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
            {"id": t.id, "card": t.card, "x": round(t.x / w, 4), "y": round(t.y / h, 4), "visible": t.visible}
            for t in self.tracks
            if t.card is not None
        ]

    def candidates(self) -> list[dict]:
        w, h = self.size
        return [
            {"id": t.id, "x": round(t.x / w, 4), "y": round(t.y / h, 4), "text": t.text,
             "confidence": round(t.confidence, 3), "reads": t.reads}
            for t in self.tracks
            if t.card is None
        ]

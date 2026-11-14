"""The vision loop: camera frame in, snapshot of cards out.

`Vision.process` does one frame and is plain synchronous code (easy to test).
`VisionWorker` runs it on a background thread, always on the newest frame.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Callable

import cv2
import numpy as np

from . import RECT_H, RECT_W
from .detect import Detection, DetectResult, detect
from .playarea import PlayArea
from .reader import Reader, Reading, crop_word
from .tracker import Tracker

CAMERA_LOST_AFTER = 2.0


class Vision:
    def __init__(self, reader: Reader | None, flip: bool = False) -> None:
        self.reader = reader
        self.play_area = PlayArea()
        self.play_area.flip = flip
        self.tracker = Tracker()
        self.lock = threading.Lock()
        # Latest results, for debug views and the phone overlay.
        self.frame: np.ndarray | None = None
        self.rect: np.ndarray | None = None
        self.result: DetectResult | None = None
        self.to_image: np.ndarray | None = None
        self.frame_size = (0, 0)
        self.last_frame_time = 0.0
        self.process_ms = 0.0
        self._times: deque[float] = deque(maxlen=30)

    # --- controls -------------------------------------------------------------

    def set_flip(self, flip: bool) -> None:
        with self.lock:
            self.play_area.flip = flip
            self.tracker.reset()

    def relock(self) -> None:
        with self.lock:
            self.play_area.relock()
            self.tracker.reset()

    # --- one frame ------------------------------------------------------------

    def process(self, frame: np.ndarray, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        started = time.perf_counter()
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        with self.lock:
            self.frame = frame
            self.frame_size = (frame.shape[1], frame.shape[0])
            self.last_frame_time = now
            self._times.append(now)
            self.play_area.update(gray, now)
            homography = self.play_area.homography()
            if homography is None:
                self.rect = None
                self.result = None
                self.to_image = None
            else:
                self.to_image = np.linalg.inv(homography)
                self.rect = cv2.warpPerspective(frame, homography, (RECT_W, RECT_H), flags=cv2.INTER_AREA)
                self.result = detect(self.rect)
                read: Callable[[Detection], Reading] | None = None
                if self.reader is not None:
                    read = self._read
                self.tracker.update(self.result.detections, self.result.occluder, now, read)
            self.process_ms = (time.perf_counter() - started) * 1000.0

    def _read(self, det: Detection) -> Reading:
        assert self.reader is not None and self.frame is not None and self.to_image is not None
        crop = crop_word(self.frame, self.to_image, det)
        return self.reader.read(crop, squarish=det.long < 1.3 * det.short)

    # --- outputs --------------------------------------------------------------

    def fps(self) -> float:
        if len(self._times) < 2:
            return 0.0
        span = self._times[-1] - self._times[0]
        return (len(self._times) - 1) / span if span > 0 else 0.0

    def snapshot(self, now: float | None = None) -> dict:
        """State for the laptop page. Positions are 0..1 across the play area."""
        now = time.monotonic() if now is None else now
        with self.lock:
            connected = self.last_frame_time > 0 and (now - self.last_frame_time) < CAMERA_LOST_AFTER
            found = self.play_area.found(now)
            return {
                "camera": {"connected": connected, "fps": round(self.fps(), 1), "processMs": round(self.process_ms, 1)},
                "playArea": {"found": found, "locked": self.play_area.locked, "flip": self.play_area.flip},
                "cards": self.tracker.cards() if connected else [],
                "candidates": self.tracker.candidates() if connected else [],
            }

    def phone_status(self, now: float | None = None) -> dict:
        """State for the phone overlay. Positions are 0..1 across the camera image."""
        now = time.monotonic() if now is None else now
        with self.lock:
            w, h = self.frame_size
            status: dict = {"found": self.play_area.found(now), "locked": self.play_area.locked, "corners": None, "cards": []}
            corners = self.play_area.ordered_corners()
            if corners is None or w == 0:
                return status
            status["corners"] = [[round(float(x) / w, 4), round(float(y) / h, 4)] for x, y in corners]
            if self.to_image is None:
                return status
            tracks = self.tracker.tracks
            if tracks:
                points = np.array([[[t.x, t.y]] for t in tracks], dtype=np.float32)
                image_points = cv2.perspectiveTransform(points, self.to_image).reshape(-1, 2)
                for track, (x, y) in zip(tracks, image_points):
                    status["cards"].append(
                        {"card": track.card, "text": track.text, "x": round(float(x) / w, 4), "y": round(float(y) / h, 4), "visible": track.visible}
                    )
            return status

    def debug_image(self) -> np.ndarray | None:
        """The rectified view with detections drawn on, for the debug page."""
        with self.lock:
            if self.rect is None or self.result is None:
                return None
            view = self.rect.copy()
            view[self.result.occluder > 0] = (0.5 * view[self.result.occluder > 0] + np.array([0, 0, 120])).astype(np.uint8)
            view[self.result.ink > 0] = (255, 80, 0)
            for det in self.result.detections:
                cv2.polylines(view, [det.box.astype(np.int32)], True, (0, 200, 255), 2)
            for track in self.tracker.tracks:
                colour = (0, 190, 0) if track.card else (0, 140, 255)
                if not track.visible:
                    colour = (160, 160, 160)
                label = track.card.upper() if track.card else f"? {track.text}"
                cv2.circle(view, (int(track.x), int(track.y)), 7, colour, -1)
                cv2.putText(view, f"{track.id}:{label}", (int(track.x) + 10, int(track.y) - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.7, colour, 2, cv2.LINE_AA)
            return view

    def crop_for(self, track_id: int) -> np.ndarray | None:
        """The word image for one scrap, as the reader sees it (for Card check)."""
        with self.lock:
            if self.frame is None or self.to_image is None:
                return None
            for track in self.tracker.tracks:
                if track.id == track_id:
                    return crop_word(self.frame, self.to_image, track.as_detection())
        return None


class VisionWorker:
    """Runs Vision on a thread. Frames arrive as JPEG bytes; only the newest is kept."""

    def __init__(self, vision: Vision, on_update: Callable[[], None] | None = None) -> None:
        self.vision = vision
        self.on_update = on_update
        self._condition = threading.Condition()
        self._pending: bytes | None = None
        self._running = True
        self.latest_jpeg: bytes | None = None
        self.frames_received = 0
        self._thread = threading.Thread(target=self._run, name="vision", daemon=True)
        self._thread.start()

    def submit(self, jpeg: bytes) -> None:
        with self._condition:
            self._pending = jpeg
            self.latest_jpeg = jpeg
            self.frames_received += 1
            self._condition.notify()

    def stop(self) -> None:
        with self._condition:
            self._running = False
            self._condition.notify()

    def _run(self) -> None:
        while True:
            with self._condition:
                while self._pending is None and self._running:
                    self._condition.wait(timeout=0.5)
                if not self._running:
                    return
                jpeg, self._pending = self._pending, None
            frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                continue
            try:
                self.vision.process(frame)
            except Exception:  # keep the demo alive whatever one frame does
                import traceback

                traceback.print_exc()
            if self.on_update is not None:
                self.on_update()

"""Replay recorded camera frames through the whole tracking pipeline.

    uv run python tools/replay_report.py recordings/first-test [every_nth_debug_image]

Prints what was tracked on each frame and writes debug pictures to
`<folder>/replay/`. Use it to check a change against real footage.
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from deck.vision.pipeline import Vision  # noqa: E402
from deck.vision.reader import Reader  # noqa: E402


def main() -> None:
    folder = Path(sys.argv[1] if len(sys.argv) > 1 else "recordings/first-test")
    every = int(sys.argv[2]) if len(sys.argv) > 2 else 25
    files = sorted(folder.glob("*.jpg"))
    out = folder / "replay"
    out.mkdir(exist_ok=True)
    vision = Vision(Reader())
    locked_frames = 0
    seen: Counter = Counter()
    last_line = ""
    for index, path in enumerate(files):
        frame = cv2.imread(str(path))
        if frame is None:
            continue
        now = index * 0.33
        vision.process(frame, now=now)
        if vision.play_area.locked:
            locked_frames += 1
        cards = vision.tracker.cards()
        candidates = vision.tracker.candidates()
        for card in cards:
            seen[card["card"]] += 1
        line = " ".join(sorted(f"{c['card']}#{c['id']}{'' if c['visible'] else '(hidden)'}" for c in cards))
        line += " | " + " ".join(sorted(f"?{c['text']}" for c in candidates))
        if line != last_line:
            print(f"{index:4d} {path.name[:6]} found={vision.play_area.found(now)!s:5} {line}")
            last_line = line
        if index % every == 0:
            view = vision.debug_image()
            if view is not None:
                cv2.imwrite(str(out / f"{index:04d}.jpg"), view)
    print(f"\n{len(files)} frames, play area locked on {locked_frames}. Card-frames: {dict(seen)}")
    print(f"Debug pictures: {out}")


if __name__ == "__main__":
    main()

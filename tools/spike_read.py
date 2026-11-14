"""Check card reading on saved camera frames.

    uv run python tools/spike_read.py recordings/snaps

For every .jpg in the folder: find the play area, find the word scraps, read
each one, and write `<folder>/report/<name>.jpg` showing what was found. Prints
a table of readings so you can see which cards are read reliably.
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from deck.vision import RECT_H, RECT_W  # noqa: E402
from deck.vision.detect import detect  # noqa: E402
from deck.vision.playarea import _long_side_first, find_quad  # noqa: E402
from deck.vision.reader import Reader, crop_word  # noqa: E402


def main() -> None:
    folder = Path(sys.argv[1] if len(sys.argv) > 1 else "recordings/snaps")
    files = sorted(folder.glob("*.jpg"))
    if not files:
        print(f"No .jpg files in {folder}")
        return
    report = folder / "report"
    report.mkdir(exist_ok=True)
    reader = Reader()
    totals: Counter = Counter()
    no_area = 0
    for path in files:
        frame = cv2.imread(str(path))
        if frame is None:
            continue
        quad = find_quad(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
        if quad is None:
            no_area += 1
            print(f"{path.name}: play area NOT found")
            continue
        quad = _long_side_first(quad)
        target = np.array([[0, 0], [RECT_W, 0], [RECT_W, RECT_H], [0, RECT_H]], dtype=np.float32)
        homography = cv2.getPerspectiveTransform(quad.astype(np.float32), target)
        to_image = np.linalg.inv(homography)
        rect = cv2.warpPerspective(frame, homography, (RECT_W, RECT_H), flags=cv2.INTER_AREA)
        result = detect(rect)
        view = rect.copy()
        view[result.occluder > 0] = (0.5 * view[result.occluder > 0] + np.array([0, 0, 120])).astype(np.uint8)
        strips = []
        line = []
        for det in result.detections:
            crop = crop_word(frame, to_image, det)
            reading = reader.read(crop, squarish=det.long < 1.3 * det.short)
            good = reading.card is not None
            totals["matched" if good else "unmatched"] += 1
            if good:
                totals[reading.card] += 1
            colour = (0, 170, 0) if good else (0, 110, 255)
            cv2.polylines(view, [det.box.astype(np.int32)], True, colour, 2)
            label = f"{reading.card.upper() if good else '?'} [{reading.text}] {reading.confidence:.2f}"
            cv2.putText(view, label, (int(det.x - det.long / 2), int(det.y - det.short / 2) - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.55, colour, 2, cv2.LINE_AA)
            strips.append(cv2.resize(crop, (int(crop.shape[1] * 48 / crop.shape[0]), 48)))
            line.append(f"{reading.card or '?'}({reading.text},{reading.confidence:.2f},rot{reading.turned})")
        if strips:
            width = max(s.shape[1] for s in strips)
            column = np.vstack([cv2.copyMakeBorder(s, 2, 2, 2, width - s.shape[1] + 2, cv2.BORDER_CONSTANT, value=(60, 60, 60)) for s in strips])
            pad = np.full((max(view.shape[0], column.shape[0]), view.shape[1] + column.shape[1], 3), 30, np.uint8)
            pad[: view.shape[0], : view.shape[1]] = view
            pad[: column.shape[0], view.shape[1] :] = column
            view = pad
        cv2.imwrite(str(report / path.name), view)
        print(f"{path.name}: {len(result.detections)} scraps: " + "  ".join(line))
    print("\nTotals:", dict(totals), f"| frames with no play area: {no_area} of {len(files)}")
    print(f"Annotated images: {report}")


if __name__ == "__main__":
    main()

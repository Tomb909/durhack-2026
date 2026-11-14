"""End-to-end vision checks on synthetic frames (no phone needed)."""

from __future__ import annotations

import json
import os

import pytest

from deck.vision.pipeline import Vision
from deck.vision.reader import Reader, load_vocabulary, match, normalise
from deck.vision.synth import Scrap, render_frame
from deck.vision.tracker import Track, Tracker

VOCAB = {"MOUNTAIN": "mountain", "WATER": "water", "SUN": "sun", "ICE": "ice", "LIFE": "life"}


@pytest.fixture(scope="module")
def reader() -> Reader:
    return Reader(load_vocabulary())


def run(vision: Vision, scraps, frames=4, start=0.0, **kwargs) -> float:
    t = start
    for i in range(frames):
        vision.process(render_frame(scraps, seed=i, **kwargs), now=t)
        t += 0.1
    return t


def by_card(vision: Vision) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for card in vision.tracker.cards():
        out.setdefault(card["card"], []).append(card)
    return out


def test_match_is_forgiving_but_not_ambiguous():
    assert match("MOUNTA1N", VOCAB) == ("mountain", 0)
    assert match("WATFR", VOCAB) == ("water", 1)
    assert match("SUN", VOCAB) == ("sun", 0)
    assert match("LICE", VOCAB)[0] is None  # ICE or LIFE? refuse to guess
    assert match("VOLCANO", VOCAB)[0] is None
    assert normalise("w4ter!") == "WATERI"


def test_reader_refreshes_vocabulary_when_card_data_changes(tmp_path):
    cards_path = tmp_path / "cards.json"
    cards_path.write_text(json.dumps([{"id": "water", "word": "WATER"}]), encoding="utf-8")
    reader = Reader.__new__(Reader)
    reader._vocabulary_path = cards_path
    reader.vocabulary = load_vocabulary(cards_path)
    initial_mtime_ns = cards_path.stat().st_mtime_ns
    reader._vocabulary_mtime_ns = initial_mtime_ns

    cards_path.write_text(json.dumps([{"id": "big", "word": "BIG"}, {"id": "water", "word": "WATER"}]), encoding="utf-8")
    changed = cards_path.stat()
    os.utime(cards_path, ns=(changed.st_atime_ns, initial_mtime_ns + 1_000_000_000))
    reader._refresh_vocabulary()

    assert match("BIG", reader.vocabulary) == ("big", 0)


def test_overlay_hides_unrecognized_letter_fragments_inside_known_card():
    tracker = Tracker()
    tracker.tracks = [
        Track(1, 100, 100, 0, 90, 30, 0, 0, card="big"),
        Track(2, 75, 100, 0, 20, 20, 0, 0, text="B?"),
        Track(3, 100, 100, 0, 15, 20, 0, 0, text="I?"),
        Track(4, 200, 100, 0, 20, 20, 0, 0, text="??"),
    ]

    assert [track.id for track in tracker.display_tracks()] == [1, 4]
    assert [candidate["text"] for candidate in tracker.candidates()] == ["??"]


def test_reads_all_six_cards_at_any_rotation(reader):
    scraps = [
        Scrap("BIG", 0.1, 0.1),
        Scrap("MOUNTAIN", 0.25, 0.25, angle=0),
        Scrap("WATER", 0.7, 0.25, angle=160),
        Scrap("SUN", 0.2, 0.7, angle=95),
        Scrap("ICE", 0.5, 0.6, angle=-40),
        Scrap("LIFE", 0.8, 0.75, angle=200),
    ]
    vision = Vision(reader)
    run(vision, scraps, frames=6)
    assert vision.play_area.locked
    cards = by_card(vision)
    assert set(cards) == {"big", "mountain", "water", "sun", "ice", "life"}
    for scrap in scraps:
        (card,) = cards[scrap.word.lower()]
        assert abs(card["x"] - scrap.x) < 0.03, (scrap.word, card)
        assert abs(card["y"] - scrap.y) < 0.03, (scrap.word, card)


def test_copies_side_by_side_are_separate_cards(reader):
    scraps = [Scrap("WATER", 0.3, 0.4), Scrap("WATER", 0.3, 0.62), Scrap("WATER", 0.62, 0.4, angle=90)]
    vision = Vision(reader)
    run(vision, scraps, frames=6)
    assert len(by_card(vision).get("water", [])) == 3


def test_flip_rotates_the_table(reader):
    vision = Vision(reader, flip=True)
    run(vision, [Scrap("SUN", 0.2, 0.3)], frames=6)
    (card,) = by_card(vision)["sun"]
    assert abs(card["x"] - 0.8) < 0.03 and abs(card["y"] - 0.7) < 0.03


def test_card_follows_a_slide_and_keeps_its_id(reader):
    vision = Vision(reader)
    t = run(vision, [Scrap("LIFE", 0.3, 0.5)], frames=5)
    first = by_card(vision)["life"][0]["id"]
    for step in range(1, 8):
        vision.process(render_frame([Scrap("LIFE", 0.3 + 0.05 * step, 0.5)], seed=step), now=t)
        t += 0.1
    (card,) = by_card(vision)["life"]
    assert card["id"] == first
    assert abs(card["x"] - 0.65) < 0.04


def test_hand_over_a_card_does_not_remove_it(reader):
    scraps = [Scrap("ICE", 0.5, 0.5), Scrap("SUN", 0.15, 0.2)]
    vision = Vision(reader)
    t = run(vision, scraps, frames=5)
    t = run(vision, scraps, frames=25, start=t, hand=(0.5, 0.5))  # 2.5 s covered
    cards = by_card(vision)
    assert "ice" in cards and not cards["ice"][0]["visible"]
    assert "sun" in cards
    run(vision, scraps, frames=3, start=t)
    assert by_card(vision)["ice"][0]["visible"]


def test_removed_card_goes_after_a_moment(reader):
    vision = Vision(reader)
    t = run(vision, [Scrap("ICE", 0.5, 0.5), Scrap("SUN", 0.2, 0.2)], frames=5)
    vision.process(render_frame([Scrap("SUN", 0.2, 0.2)]), now=t)
    assert "ice" in by_card(vision)  # one missed frame is not a removal
    run(vision, [Scrap("SUN", 0.2, 0.2)], frames=8, start=t + 0.1)
    assert "ice" not in by_card(vision)


def test_picked_up_and_put_down_elsewhere_is_a_move(reader):
    vision = Vision(reader)
    t = run(vision, [Scrap("WATER", 0.3, 0.4)], frames=5)
    first = by_card(vision)["water"][0]["id"]
    t = run(vision, [Scrap("WATER", 0.3, 0.4)], frames=4, start=t, hand=(0.3, 0.4))
    # Hand still over the old place; the card is now down somewhere else.
    t = run(vision, [Scrap("WATER", 0.75, 0.3)], frames=5, start=t, hand=(0.3, 0.4))
    waters = by_card(vision)["water"]
    assert len(waters) == 1 and waters[0]["id"] == first
    assert abs(waters[0]["x"] - 0.75) < 0.04


def test_nudged_phone_keeps_tracking(reader):
    scraps = [Scrap("MOUNTAIN", 0.3, 0.3), Scrap("LIFE", 0.7, 0.7)]
    vision = Vision(reader)
    t = run(vision, scraps, frames=5)
    ids = {c["id"] for c in vision.tracker.cards()}
    t = run(vision, scraps, frames=6, start=t, shift=(0.012, -0.01), tilt=0.13)
    cards = by_card(vision)
    assert {c["id"] for c in vision.tracker.cards()} == ids
    assert abs(cards["mountain"][0]["x"] - 0.3) < 0.03
    assert abs(cards["life"][0]["y"] - 0.7) < 0.03


def test_cards_in_a_deep_shadow_are_read_and_the_shadow_is_not_an_object(reader):
    # The phone's own shadow: half the sheet at about a third of the brightness.
    scraps = [Scrap("WATER", 0.2, 0.4, angle=20), Scrap("LIFE", 0.3, 0.75, angle=-70), Scrap("SUN", 0.8, 0.3)]
    vision = Vision(reader)
    run(vision, scraps, frames=8, shadow=0.34)
    assert set(by_card(vision)) == {"water", "life", "sun"}
    covered = (vision.result.occluder > 0).mean()
    assert covered < 0.01, f"{covered:.1%} of the sheet was treated as a covering object"


def test_card_removed_from_a_shadow_is_let_go(reader):
    vision = Vision(reader)
    t = run(vision, [Scrap("WATER", 0.2, 0.4), Scrap("SUN", 0.8, 0.3)], frames=6, shadow=0.34)
    run(vision, [Scrap("SUN", 0.8, 0.3)], frames=8, start=t, shadow=0.34)
    assert "water" not in by_card(vision)


def test_shadow_arriving_over_a_card_does_not_lose_it(reader):
    scraps = [Scrap("ICE", 0.25, 0.5), Scrap("SUN", 0.8, 0.3)]
    vision = Vision(reader)
    t = run(vision, scraps, frames=6)
    run(vision, scraps, frames=10, start=t, shadow=0.4)  # someone leans over
    cards = by_card(vision)
    assert "ice" in cards and cards["ice"][0]["visible"]


def test_small_words_on_scraps_stacked_close_stay_separate(reader):
    # Small writing on scraps cut close to the word and stacked: the lines of
    # writing are nearer to each other than the letters are tall.
    scraps = [
        Scrap("WATER", 0.6, 0.40, angle=12, letter_mm=11, pad_mm=3.5),
        Scrap("WATER", 0.6, 0.47, angle=12, letter_mm=11, pad_mm=3.5),
        Scrap("WATER", 0.6, 0.54, angle=12, letter_mm=11, pad_mm=3.5),
    ]
    vision = Vision(reader)
    t = run(vision, scraps, frames=8)
    assert len(by_card(vision).get("water", [])) == 3
    ids = sorted(c["id"] for c in vision.tracker.cards())
    run(vision, scraps, frames=20, start=t)
    assert sorted(c["id"] for c in vision.tracker.cards()) == ids  # steady: no card comes and goes


def test_widely_spaced_letters_are_still_one_word(reader):
    from deck.vision.detect import detect
    from deck.vision.synth import render_sheet
    import cv2

    # Letters drawn one by one with big gaps along the line.
    sheet = render_sheet([])
    x = 500
    for letter in "MOUNTAIN":
        cv2.putText(sheet, letter, (x, 600), cv2.FONT_HERSHEY_SIMPLEX, 2.0, (25, 25, 25), 8, cv2.LINE_AA)
        x += 75
    inner = sheet[92:-92, 92:-92]
    rect = cv2.resize(inner, (1050, 742), interpolation=cv2.INTER_AREA)
    words = detect(rect).detections
    assert len(words) == 1, [round(d.long) for d in words]


# --- play areas of any shape -------------------------------------------------------


@pytest.mark.parametrize("border", ["circle", "blob"])
def test_any_closed_border_is_a_play_area(reader, border):
    # Positions are fractions of the shape's bounding box, as for a rectangle.
    scraps = [Scrap("SUN", 0.5, 0.3), Scrap("ICE", 0.3, 0.6, angle=30), Scrap("LIFE", 0.68, 0.62, angle=-20)]
    vision = Vision(reader)
    run(vision, scraps, frames=6, border=border)
    assert vision.play_area.locked and not vision.play_area.four_sided
    shape = vision.snapshot(now=0.55)["playArea"]["shape"]
    assert shape is not None and len(shape["outline"]) >= 12
    cards = by_card(vision)
    for scrap in scraps:
        (card,) = cards[scrap.word.lower()]
        assert abs(card["x"] - scrap.x) < 0.03, (scrap.word, card)
        assert abs(card["y"] - scrap.y) < 0.03, (scrap.word, card)


def test_circle_gives_a_round_world(reader):
    vision = Vision(reader)
    run(vision, [Scrap("SUN", 0.5, 0.5)], frames=5, border="circle")
    shape = vision.snapshot(now=0.45)["playArea"]["shape"]
    assert abs(shape["aspect"] - 1.0) < 0.04
    import numpy as np

    radii = [np.hypot(x - 0.5, y - 0.5) for x, y in shape["outline"]]
    assert 0.46 < min(radii) and max(radii) < 0.52


def test_rectangle_world_is_unchanged(reader):
    vision = Vision(reader)
    run(vision, [Scrap("SUN", 0.5, 0.5)], frames=5)
    shape = vision.snapshot(now=0.45)["playArea"]["shape"]
    assert vision.play_area.four_sided
    assert shape["outline"] == [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]
    assert vision.play_area.rect_size() == (1050, 742)


def test_scrap_outside_the_circle_is_ignored(reader):
    # Two identical small scraps: one in the corner of the circle's bounding box
    # (outside the circle, clear of its line), one in the middle.
    small = dict(letter_mm=9, pad_mm=2)
    vision = Vision(reader)
    run(vision, [Scrap("ICE", 0.04, 0.05, **small), Scrap("ICE", 0.5, 0.5, **small)], frames=6, border="circle")
    (ice,) = by_card(vision)["ice"]
    assert abs(ice["x"] - 0.5) < 0.03 and abs(ice["y"] - 0.5) < 0.03


def test_circle_with_no_sheet_edge_in_view():
    # Looking straight down at a big sheet: only the drawn circle is visible.
    import cv2
    import numpy as np

    from deck.vision.playarea import find_outlines

    image = np.full((1080, 1920), 235, np.uint8)
    cv2.circle(image, (960, 540), 420, 20, 22)
    (outline, *_) = find_outlines(image)
    assert not outline.four_sided
    assert abs(outline.aspect - 1.0) < 0.03

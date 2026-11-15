"""End-to-end vision checks on synthetic frames (no phone needed)."""

from __future__ import annotations

import json
import math
import os

import pytest

from deck.vision import playarea
from deck.vision.pipeline import Vision
from deck.vision.reader import Reader, load_vocabulary, match, normalise
from deck.vision.synth import Scrap, render_frame
from deck.vision.tracker import Track, Tracker

VOCAB = load_vocabulary()  # the same words the app uses (web/src/cards/cards.json)


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
    assert match("WATFR", VOCAB) == ("rain", 1)
    assert match("SUN", VOCAB) == ("sun", 0)
    assert match("LICE", VOCAB)[0] is None  # ICE or LIFE? refuse to guess
    assert match("CASTLE", VOCAB)[0] is None  # not a card, and not close to one
    assert match("VOLCANO", VOCAB)[0] is None  # not a card: MOUNTAIN next to LAVA makes one
    assert normalise("w4ter!") == "WATERI"
    assert match("SETTLEMENT", VOCAB) == ("civilization", 0)
    assert match("SETTLEMNT", VOCAB) == ("civilization", 1)
    # Water is three cards. Settlement is one, CIVILIZATION: the words for its sizes all read as it.
    for word, card in [("RAIN", "rain"), ("LAKE", "lake"), ("RIVER", "river"), ("CIVILIZATION", "civilization"), ("CIVILISATION", "civilization"), ("VILLAGE", "civilization"), ("TOWN", "civilization"), ("CITY", "civilization"), ("PEOPLE", "civilization")]:
        assert match(word, VOCAB) == (card, 0)
    assert match("RIVFR", VOCAB) == ("river", 1)
    assert match("VILLAGF", VOCAB) == ("civilization", 1)
    assert match("CIVILIZATI0N", VOCAB) == ("civilization", 0)
    assert match("CIVILZATION", VOCAB) == ("civilization", 1)


def test_reader_refreshes_vocabulary_when_card_data_changes(tmp_path):
    cards_path = tmp_path / "cards.json"
    cards_path.write_text(json.dumps([{"id": "rain", "word": "WATER"}]), encoding="utf-8")
    reader = Reader.__new__(Reader)
    reader._vocabulary_path = cards_path
    reader.vocabulary = load_vocabulary(cards_path)
    initial_mtime_ns = cards_path.stat().st_mtime_ns
    reader._vocabulary_mtime_ns = initial_mtime_ns

    cards_path.write_text(json.dumps([{"id": "big", "word": "BIG"}, {"id": "rain", "word": "WATER"}]), encoding="utf-8")
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


def test_wind_card_output_preserves_arrow_direction_from_text_orientation():
    tracker = Tracker()
    tracker.tracks = [Track(1, 100, 100, 20, 90, 30, 0, 0, card="wind", turned=180)]

    (card,) = tracker.cards()

    assert card["angle"] == pytest.approx(math.radians(200), abs=1e-5)


def test_camera_distinguishes_opposite_wind_card_orientations(reader):
    scraps = [Scrap("WIND", 0.3, 0.5), Scrap("WIND", 0.7, 0.5, angle=180)]
    vision = Vision(reader)
    run(vision, scraps, frames=7)

    winds = by_card(vision)["wind"]

    assert len(winds) == 2
    difference = math.atan2(math.sin(winds[0]["angle"] - winds[1]["angle"]), math.cos(winds[0]["angle"] - winds[1]["angle"]))
    assert abs(difference) == pytest.approx(math.pi, abs=0.15)


def test_reads_every_card_at_any_rotation(reader):
    scraps = [
        Scrap("BIG", 0.1, 0.1),
        Scrap("MOUNTAIN", 0.25, 0.25, angle=0),
        Scrap("RAIN", 0.7, 0.25, angle=160),
        Scrap("SUN", 0.2, 0.7, angle=95),
        Scrap("ICE", 0.5, 0.6, angle=-40),
        Scrap("FOREST", 0.8, 0.75, angle=200),
        Scrap("CIVILIZATION", 0.5, 0.88, angle=5),
    ]
    vision = Vision(reader)
    run(vision, scraps, frames=6)
    assert vision.play_area.locked
    cards = by_card(vision)
    assert set(cards) == {"big", "mountain", "rain", "sun", "ice", "forest", "civilization"}
    for scrap in scraps:
        (card,) = cards[scrap.word.lower()]
        assert abs(card["x"] - scrap.x) < 0.03, (scrap.word, card)
        assert abs(card["y"] - scrap.y) < 0.03, (scrap.word, card)


def test_copies_side_by_side_are_separate_cards(reader):
    scraps = [Scrap("WATER", 0.3, 0.4), Scrap("WATER", 0.3, 0.62), Scrap("WATER", 0.62, 0.4, angle=90)]
    vision = Vision(reader)
    run(vision, scraps, frames=6)
    assert len(by_card(vision).get("rain", [])) == 3


def test_flip_rotates_the_table(reader):
    vision = Vision(reader, flip=True)
    run(vision, [Scrap("SUN", 0.2, 0.3)], frames=6)
    (card,) = by_card(vision)["sun"]
    assert abs(card["x"] - 0.8) < 0.03 and abs(card["y"] - 0.7) < 0.03


def test_card_follows_a_slide_and_keeps_its_id(reader):
    vision = Vision(reader)
    t = run(vision, [Scrap("FOREST", 0.3, 0.5)], frames=5)
    first = by_card(vision)["forest"][0]["id"]
    for step in range(1, 8):
        vision.process(render_frame([Scrap("FOREST", 0.3 + 0.05 * step, 0.5)], seed=step), now=t)
        t += 0.1
    (card,) = by_card(vision)["forest"]
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
    first = by_card(vision)["rain"][0]["id"]
    t = run(vision, [Scrap("WATER", 0.3, 0.4)], frames=4, start=t, hand=(0.3, 0.4))
    # Hand still over the old place; the card is now down somewhere else.
    t = run(vision, [Scrap("WATER", 0.75, 0.3)], frames=5, start=t, hand=(0.3, 0.4))
    waters = by_card(vision)["rain"]
    assert len(waters) == 1 and waters[0]["id"] == first
    assert abs(waters[0]["x"] - 0.75) < 0.04


def test_nudged_phone_keeps_tracking(reader):
    scraps = [Scrap("MOUNTAIN", 0.3, 0.3), Scrap("FOREST", 0.7, 0.7)]
    vision = Vision(reader)
    t = run(vision, scraps, frames=5)
    ids = {c["id"] for c in vision.tracker.cards()}
    t = run(vision, scraps, frames=6, start=t, shift=(0.012, -0.01), tilt=0.13)
    cards = by_card(vision)
    assert {c["id"] for c in vision.tracker.cards()} == ids
    assert abs(cards["mountain"][0]["x"] - 0.3) < 0.03
    assert abs(cards["forest"][0]["y"] - 0.7) < 0.03


def test_cards_in_a_deep_shadow_are_read_and_the_shadow_is_not_an_object(reader):
    # The phone's own shadow: half the sheet at about a third of the brightness.
    scraps = [Scrap("WATER", 0.2, 0.4, angle=20), Scrap("FOREST", 0.3, 0.75, angle=-70), Scrap("SUN", 0.8, 0.3)]
    vision = Vision(reader)
    run(vision, scraps, frames=8, shadow=0.34)
    assert set(by_card(vision)) == {"rain", "forest", "sun"}
    covered = (vision.result.occluder > 0).mean()
    assert covered < 0.01, f"{covered:.1%} of the sheet was treated as a covering object"


def test_card_removed_from_a_shadow_is_let_go(reader):
    vision = Vision(reader)
    t = run(vision, [Scrap("WATER", 0.2, 0.4), Scrap("SUN", 0.8, 0.3)], frames=6, shadow=0.34)
    run(vision, [Scrap("SUN", 0.8, 0.3)], frames=8, start=t, shadow=0.34)
    assert "rain" not in by_card(vision)


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
    assert len(by_card(vision).get("rain", [])) == 3
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
# Switched off while playarea.RECTANGLE_ONLY is set: the play area is always a rectangle.

any_shape = pytest.mark.skipif(playarea.RECTANGLE_ONLY, reason="play area is locked to a rectangle")
BORDERS = ["rect"] if playarea.RECTANGLE_ONLY else ["rect", "circle", "blob"]


@pytest.mark.skipif(not playarea.RECTANGLE_ONLY, reason="any closed border is a play area")
def test_a_circle_is_not_taken_as_the_play_area():
    vision = Vision(None)
    t = run(vision, [], frames=5, border="rect")
    run(vision, [], frames=40, start=t, border="circle")  # a different sheet is put down
    assert vision.play_area.four_sided
    assert vision.play_area.outline() in (None, [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]])


@any_shape
@pytest.mark.parametrize("border", ["circle", "blob"])
def test_any_closed_border_is_a_play_area(reader, border):
    # Positions are fractions of the shape's bounding box, as for a rectangle.
    scraps = [Scrap("SUN", 0.5, 0.3), Scrap("ICE", 0.3, 0.6, angle=30), Scrap("FOREST", 0.68, 0.62, angle=-20)]
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


@any_shape
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


@any_shape
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


# --- a hand reaching in must not change the play area ---------------------------------

HAND_SPOTS = [(0.5, 0.5), (0.15, 0.8), (0.5, 0.05), (0.97, 0.6)]


def area_state(vision: Vision, now: float):
    import numpy as np

    area = vision.play_area
    return np.array(area.corners), vision.snapshot(now=now)["playArea"]["shape"], area.rect_size()


@pytest.mark.parametrize("border", BORDERS)
def test_a_hand_reaching_in_does_not_change_the_play_area(border):
    import numpy as np

    scraps = [Scrap("WATER", 0.3, 0.35), Scrap("FOREST", 0.7, 0.6)]
    vision = Vision(None)
    t = run(vision, scraps, frames=5, border=border)
    corners, shape, size = area_state(vision, t)
    for hand in HAND_SPOTS:
        t = run(vision, scraps, frames=16, start=t, border=border, hand=hand)  # 1.6 s resting there
        now_corners, now_shape, now_size = area_state(vision, t)
        assert np.abs(now_corners - corners).max() < 3, (border, hand)
        assert now_shape == shape and now_size == size, (border, hand)
        assert vision.play_area.found(t), (border, hand)  # still "found": the border is plainly there
        t = run(vision, scraps, frames=3, start=t, border=border)


@any_shape
def test_a_card_under_a_hand_in_a_circle_is_held(reader):
    scraps = [Scrap("SUN", 0.5, 0.45), Scrap("ICE", 0.3, 0.6)]
    vision = Vision(reader)
    t = run(vision, scraps, frames=6, border="circle")
    before = {c["card"]: (c["id"], c["x"], c["y"]) for c in vision.tracker.cards()}
    assert set(before) == {"sun", "ice"}
    t = run(vision, scraps, frames=25, start=t, border="circle", hand=(0.5, 0.45))
    t = run(vision, scraps, frames=4, start=t, border="circle")
    after = {c["card"]: (c["id"], c["x"], c["y"]) for c in vision.tracker.cards()}
    assert set(after) == {"sun", "ice"}
    for card, (card_id, x, y) in before.items():
        assert after[card][0] == card_id
        assert abs(after[card][1] - x) < 0.02 and abs(after[card][2] - y) < 0.02


@pytest.mark.parametrize("border", BORDERS)
def test_a_nudged_phone_is_still_followed_for_any_border(border):
    import numpy as np

    scraps = [Scrap("WATER", 0.3, 0.35)]
    vision = Vision(None)
    t = run(vision, scraps, frames=5, border=border)
    corners, shape, size = area_state(vision, t)
    t = run(vision, scraps, frames=10, start=t, border=border, shift=(0.012, -0.01))
    moved, now_shape, now_size = area_state(vision, t)
    shift = (moved - corners).mean(axis=0)
    assert abs(shift[0] - 0.012 * 1920) < 4 and abs(shift[1] + 0.01 * 1080) < 4, shift
    assert now_size == size
    # ... and a hand reaching in afterwards changes nothing at the new place.
    t = run(vision, scraps, frames=20, start=t, border=border, shift=(0.012, -0.01), hand=(0.5, 0.6))
    assert np.abs(vision.play_area.corners - moved).max() < 3


def test_a_re_propped_phone_is_picked_up_again():
    scraps = [Scrap("WATER", 0.3, 0.35)]
    vision = Vision(None)
    t = run(vision, scraps, frames=5)
    corners, _, _ = area_state(vision, t)
    t = run(vision, scraps, frames=12, start=t, shift=(0.06, 0.03))  # too far to be a nudge
    moved, _, _ = area_state(vision, t)
    shift = (moved - corners).mean(axis=0)
    assert abs(shift[0] - 0.06 * 1920) < 5 and abs(shift[1] - 0.03 * 1080) < 5, shift


@any_shape
def test_a_new_border_replaces_the_old_one():
    vision = Vision(None)
    t = run(vision, [], frames=5, border="rect")
    assert vision.play_area.four_sided
    t = run(vision, [], frames=25, start=t, border="circle")  # a different sheet is put down
    assert not vision.play_area.four_sided
    assert abs(vision.play_area.aspect - 1.0) < 0.04


@pytest.mark.parametrize("border", BORDERS)
def test_locking_with_a_hand_in_the_way_comes_right_when_it_leaves(border):
    import numpy as np

    clean = Vision(None)
    t = run(clean, [], frames=5, border=border)
    corners, shape, size = area_state(clean, t)

    vision = Vision(None)
    t = run(vision, [], frames=8, border=border, hand=(0.5, 0.6))
    t = run(vision, [], frames=30, start=t, border=border)
    now_corners, now_shape, now_size = area_state(vision, t)
    assert vision.play_area.locked
    assert now_size == size
    assert np.abs(now_corners - corners).max() < 4
    assert len(now_shape["outline"]) == len(shape["outline"])


# --- a word that is no known card -------------------------------------------------------------


def test_a_word_that_is_no_card_becomes_one_once_it_has_been_read_the_same_way(reader):
    scraps = [Scrap("FOREST", 0.25, 0.3), Scrap("ROCKETSHIP", 0.65, 0.6)]
    vision = Vision(reader)
    t = run(vision, scraps, frames=5)
    assert "rocketship" not in by_card(vision)  # half a second is not long enough
    assert [c["text"] for c in vision.tracker.candidates()] == ["ROCKETSHIP"]
    t = run(vision, scraps, frames=8, start=t)
    cards = by_card(vision)
    (made,) = cards["rocketship"]
    assert made["word"] == "ROCKETSHIP" and abs(made["x"] - 0.65) < 0.03
    assert "word" not in cards["forest"][0]  # a known card says nothing more than before
    assert vision.tracker.candidates() == []
    # It is a card like any other: a hand over it does not remove it.
    run(vision, scraps, frames=15, start=t, hand=(0.65, 0.6))
    assert by_card(vision)["rocketship"][0]["id"] == made["id"]


def test_a_word_that_is_no_card_can_be_left_as_a_candidate(reader):
    vision = Vision(reader)
    vision.tracker.make_words = False
    run(vision, [Scrap("ROCKETSHIP", 0.5, 0.5)], frames=15)
    assert vision.tracker.cards() == [] and len(vision.tracker.candidates()) == 1


def test_text_that_keeps_changing_or_is_unsure_is_not_a_word():
    from deck.vision.detect import Detection
    from deck.vision.reader import Reading

    def track_after(readings):
        tracker, seen = Tracker(), iter(readings)
        for i in range(len(readings)):
            tracker.update([Detection(300, 300, 0, 200, 50, 0.0)], None, i * 0.2, lambda det: next(seen))
        return tracker.tracks[0]

    unknown = lambda text, confidence=0.95: Reading(None, text, confidence, 99, 0, phrase=text)  # noqa: E731
    assert track_after([unknown("CASTLE")] * 6).card == "castle"
    assert track_after([unknown("CASTLE"), unknown("CASTLF")] * 5).card is None  # never the same twice
    assert track_after([unknown("CASTLE", 0.5)] * 8).card is None  # not sure enough
    assert track_after([unknown("OK")] * 8).card is None  # too short to be a word
    spaced = track_after([Reading(None, "HAUNTEDHOUSE", 0.9, 99, 0, phrase="HAUNTED HOUSE")] * 6)
    assert (spaced.card, spaced.word) == ("hauntedhouse", "HAUNTED HOUSE")
    # Seen as a known card after all (it is looked at again every few seconds): it becomes that
    # card, and is no longer a made word.
    known = Reading("forest", "FOREST", 0.95, 0, 0)
    healed = track_after([unknown("FORFSTXY")] * 5 + [known] * 60)
    assert (healed.card, healed.word) == ("forest", "")

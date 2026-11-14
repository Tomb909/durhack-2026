"""End-to-end vision checks on synthetic frames (no phone needed)."""

from __future__ import annotations

import pytest

from deck.vision.pipeline import Vision
from deck.vision.reader import Reader, match, normalise
from deck.vision.synth import Scrap, render_frame

VOCAB = {"MOUNTAIN": "mountain", "WATER": "water", "SUN": "sun", "ICE": "ice", "LIFE": "life"}


@pytest.fixture(scope="module")
def reader() -> Reader:
    return Reader(VOCAB)


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


def test_reads_all_five_cards_at_any_rotation(reader):
    scraps = [
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
    assert set(cards) == {"mountain", "water", "sun", "ice", "life"}
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

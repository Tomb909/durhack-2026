"""Any word becomes a card: the server's half, with the model client stubbed (no network, no cost)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from deck.words import CARD_SCHEMA, PROMPT, Unavailable, WordService, WordStore, card_from_reply, normalise_word, word_id

REPLY = {
    "reading": "A stone keep with four corner towers. Stands on land.",
    "icon": "🏰",
    "color": "#9d978c",
    "effects": [],
    "tint": "#ffffff",
    "tint_strength": 0,
    "light": 0,
    "particles": "none",
    "particle_color": "#ffffff",
    "particle_size": 0,
    "particle_density": 0,
    "particle_glow": False,
    "has_object": True,
    "scale": "large",
    "count": "one",
    "habitat": "land",
    "motion": "still",
    "glow": False,
    "parts": [
        {"shape": "box", "x": 0, "y": 0.3, "z": 0, "width": 0.5, "height": 0.6, "depth": 0.5,
         "rx": 0, "ry": 0, "rz": 0, "color": "#8f8a80"},
    ],
}


class StubMessages:
    def __init__(self, reply: dict, stop_reason: str = "end_turn", delay: float = 0.0) -> None:
        self.reply = reply
        self.stop_reason = stop_reason
        self.delay = delay
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        await asyncio.sleep(self.delay)
        block = SimpleNamespace(type="text", text=json.dumps(self.reply))
        return SimpleNamespace(stop_reason=self.stop_reason, content=[block] if self.stop_reason != "refusal" else [])


def stub(reply=REPLY, **kwargs) -> tuple[StubMessages, object]:
    messages = StubMessages(reply, **kwargs)
    return messages, SimpleNamespace(beta=SimpleNamespace(messages=messages))


def no_credentials():
    raise TypeError('"Could not resolve authentication method. Expected one of api_key, auth_token, or credentials to be set."')


async def with_client(service: WordService, run):
    app = web.Application()
    service.add_routes(app)
    async with TestClient(TestServer(app)) as client:
        return await run(client)


def test_ids_match_the_page():
    # The same cases as web/src/cards/words.test.ts: the page and the server must agree.
    assert normalise_word("  haunted   house ") == "HAUNTED HOUSE"
    assert word_id("haunted house") == "haunted-house"
    assert word_id("Café") == "cafe"
    assert word_id("3d") == "w-3d"
    assert word_id("empty") == "w-empty"
    assert word_id("x3") == "w-x3"
    assert word_id("火山") == word_id(" 火山 ")
    assert word_id("火山").startswith("w-") and len(word_id("火山")) == 10
    assert word_id("火山") == "w-cf8159af"
    assert len(normalise_word("a" * 100)) == 40
    assert normalise_word("<script>x</script>") == "SCRIPT X /SCRIPT"


def test_store_round_trips(tmp_path: Path):
    path = tmp_path / "words.json"
    store = WordStore(path)
    card = card_from_reply("CASTLE", REPLY, 1234)
    store.put(card)
    again = WordStore(path)
    assert again.get("castle") == card
    assert [c["id"] for c in again.all()] == ["castle"]
    # Hand-editable: the file is plain JSON in the shape of cards.json entries.
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["cards"][0]["word"] == "CASTLE" and data["cards"][0]["prop"]["parts"][0]["shape"] == "box"
    assert not list(tmp_path.glob(".words-*"))  # no temporary file left behind


def test_reply_becomes_a_card_entry():
    card = card_from_reply("SWAMP", {**REPLY, "has_object": False, "particles": "drift",
                                     "effects": [{"field": "seaLevel", "amount": 0.01, "radius": 0.2},
                                                 {"field": "wetness", "amount": 0.4, "radius": 0.15}]}, 10)
    assert card["id"] == "swamp" and card["origin"] == "llm"
    assert card["effects"][0] == {"field": "seaLevel", "amount": 0.01, "global": True}
    assert card["effects"][1]["radius"] == 0.15
    assert "prop" not in card
    assert card["atmosphere"]["particles"]["motion"] == "drift"


def test_schema_is_strict_everywhere():
    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "object":
                assert node["additionalProperties"] is False
                assert set(node["required"]) == set(node["properties"])
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(CARD_SCHEMA)
    assert "<word>" in PROMPT


def test_makes_stores_and_reuses(tmp_path: Path):
    messages, client = stub()
    service = WordService(WordStore(tmp_path / "words.json"), client_factory=lambda: client)

    async def run(http):
        first = await http.post("/api/word", json={"text": "castle"})
        assert first.status == 200
        body = await first.json()
        assert body["source"] == "model" and body["card"]["id"] == "castle"
        second = await (await http.post("/api/word", json={"text": "  Castle "})).json()
        assert second["source"] == "store"
        fresh = await (await http.post("/api/word", json={"text": "castle", "fresh": True})).json()
        assert fresh["source"] == "model"
        listed = await (await http.get("/api/words")).json()
        return listed

    listed = asyncio.run(with_client(service, run))
    assert [c["id"] for c in listed["cards"]] == ["castle"]
    assert len(messages.calls) == 2
    call = messages.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["output_config"]["effort"] == "low"
    assert call["output_config"]["format"]["type"] == "json_schema"
    assert call["messages"][0]["content"] == "<word>CASTLE</word>"
    for rejected in ("temperature", "thinking", "tool_choice"):
        assert rejected not in call


def test_same_word_at_once_shares_one_call(tmp_path: Path):
    messages, client = stub(delay=0.2)
    service = WordService(WordStore(tmp_path / "words.json"), client_factory=lambda: client)

    async def run(http):
        replies = await asyncio.gather(*(http.post("/api/word", json={"text": "castle"}) for _ in range(3)))
        return [r.status for r in replies]

    assert asyncio.run(with_client(service, run)) == [200, 200, 200]
    assert len(messages.calls) == 1


def test_no_credentials_is_503(tmp_path: Path):
    service = WordService(WordStore(tmp_path / "words.json"), client_factory=no_credentials)

    async def run(http):
        reply = await http.post("/api/word", json={"text": "castle"})
        return reply.status, await reply.json()

    status, body = asyncio.run(with_client(service, run))
    assert status == 503 and "credentials" in body["reason"]
    assert not (tmp_path / "words.json").exists()


def test_refusal_and_cut_off_are_no_card(tmp_path: Path):
    for reason in ("refusal", "max_tokens"):
        _, client = stub(stop_reason=reason)
        service = WordService(WordStore(tmp_path / f"{reason}.json"), client_factory=lambda: client)
        with pytest.raises(Unavailable):
            asyncio.run(service.resolve("castle"))
        assert not (tmp_path / f"{reason}.json").exists()


def test_slow_model_times_out(tmp_path: Path):
    _, client = stub(delay=1.0)
    service = WordService(WordStore(tmp_path / "words.json"), client_factory=lambda: client, timeout=0.05)
    with pytest.raises(Unavailable, match="no answer"):
        asyncio.run(service.resolve("castle"))


def test_bad_requests(tmp_path: Path):
    _, client = stub()
    service = WordService(WordStore(tmp_path / "words.json"), client_factory=lambda: client)

    async def run(http):
        a = await http.post("/api/word", data="not json")
        b = await http.post("/api/word", json={"text": "   "})
        c = await http.post("/api/word", json={"text": 5})
        return a.status, b.status, c.status

    assert asyncio.run(with_client(service, run)) == (400, 400, 400)

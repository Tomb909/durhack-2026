"""Any word becomes a card: the server's half, with the model client stubbed (no network, no cost)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from deck.words import CARD_SCHEMA, PROMPT, Unavailable, WordService, WordStore, card_from_reply, normalise_word, why_not, word_id
import deck.words as words


@pytest.fixture(autouse=True)
def same_on_every_machine(monkeypatch):
    """Whatever the machine's keys file says, these tests start the same and can never reach the real model."""
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(words, "MODEL", words.DEFAULT_MODEL)
    monkeypatch.setattr(words, "EFFORT", "low")


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


class StubInteractions:
    """Stands in for `client.aio.interactions` (Gemini's Interactions API)."""

    def __init__(self, reply: dict, status: str = "completed", error: Exception | None = None, delay: float = 0.0) -> None:
        self.reply, self.status, self.error, self.delay = reply, status, error, delay
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        return SimpleNamespace(status=self.status, output_text=json.dumps(self.reply))


def stub(reply=REPLY, **kwargs) -> tuple[StubInteractions, object]:
    interactions = StubInteractions(reply, **kwargs)
    return interactions, SimpleNamespace(aio=SimpleNamespace(interactions=interactions))


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
    assert call["model"] == "gemini-4-hydrogen" and call["input"] == "<word>CASTLE</word>"
    assert call["system_instruction"] == PROMPT
    # The schema rides in response_format (response_mime_type is the old, deprecated way).
    assert call["response_format"] == {"type": "text", "mime_type": "application/json", "schema": CARD_SCHEMA}
    assert call["generation_config"] == {"thinking_level": "low"}
    assert call["store"] is False and call["timeout"] == words.TIMEOUT
    assert "response_mime_type" not in call and "temperature" not in call["generation_config"]


def test_same_word_at_once_shares_one_call(tmp_path: Path):
    messages, client = stub(delay=0.2)
    service = WordService(WordStore(tmp_path / "words.json"), client_factory=lambda: client)

    async def run(http):
        replies = await asyncio.gather(*(http.post("/api/word", json={"text": "castle"}) for _ in range(3)))
        return [r.status for r in replies]

    assert asyncio.run(with_client(service, run)) == [200, 200, 200]
    assert len(messages.calls) == 1


def test_without_a_key_is_503(tmp_path: Path):
    service = WordService(WordStore(tmp_path / "words.json"))  # the real client factory, and no key (see the fixture)

    async def run(http):
        reply = await http.post("/api/word", json={"text": "castle"})
        return reply.status, await reply.json()

    status, body = asyncio.run(with_client(service, run))
    assert status == 503 and "no Gemini key" in body["reason"] and "GEMINI_API_KEY" in body["reason"]
    assert not (tmp_path / "words.json").exists()
    assert "no GEMINI_API_KEY" in service.describe()


def test_an_unfinished_answer_is_no_card(tmp_path: Path):
    for status in ("incomplete", "failed", "cancelled"):
        _, client = stub(status=status)
        service = WordService(WordStore(tmp_path / f"{status}.json"), client_factory=lambda: client)
        with pytest.raises(Unavailable, match="did not finish"):
            asyncio.run(service.resolve("castle"))
        assert not (tmp_path / f"{status}.json").exists()


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


class Carrying(Exception):
    """An error that carries what the SDK's errors carry, without being one of its classes."""

    def __init__(self, message: str, **carried) -> None:
        super().__init__(message)
        self.message = message
        for name, value in carried.items():
            setattr(self, name, value)


def test_failures_say_why_whatever_class_the_sdk_raises():
    # The Interactions API's own errors carry `status_code`; `google.genai.errors` carry `code` and `status`.
    assert "key was refused" in why_not(Carrying("no", status_code=401))
    assert "key was refused" in why_not(Carrying("no", code=403, status="PERMISSION_DENIED"))
    assert "key was refused" in why_not(Carrying("API key not valid. Please pass a valid API key.", status_code=400))
    assert "rate limited" in why_not(Carrying("quota", status_code=429))
    assert "rate limited" in why_not(Carrying("quota", code=429, status="RESOURCE_EXHAUSTED"))
    wrong = why_not(Carrying("models/gemini-9 is not found", status_code=404))
    assert "404" in wrong and "gemini-9 is not found" in wrong  # the reason is worth reading
    assert why_not(OSError("no route")) == "could not reach the model (OSError)"
    assert why_not(Carrying("timed out", status_code=None)) == "could not reach the model (Carrying)"


def test_the_sdks_own_errors_are_understood():
    """The real classes, built the way the SDK builds them (skipped if it has moved them)."""
    try:  # the SDK runs on either
        import httpx
    except ImportError:
        httpx = pytest.importorskip("httpx2")
    compat = pytest.importorskip("google.genai._interactions.core.error")
    from google.genai import errors

    def answer(status: int):
        return httpx.Response(status, request=httpx.Request("POST", "https://example.invalid/interactions"))

    assert "rate limited" in why_not(compat.RateLimitError("quota", response=answer(429), body=None))
    assert "key was refused" in why_not(compat.PermissionDeniedError("no", response=answer(403), body=None))
    assert "400" in why_not(compat.BadRequestError("thinking_level xlow is not valid", response=answer(400), body=None))
    assert "rate limited" in why_not(errors.ClientError(429, {"error": {"code": 429, "message": "quota", "status": "RESOURCE_EXHAUSTED"}}))


def test_failures_are_no_card(tmp_path: Path):
    for name, error, expected in [
        ("busy", Carrying("quota", status_code=429), "rate limited"),
        ("refused", Carrying("no", status_code=403), "key was refused"),
        ("offline", OSError("no route"), "could not reach"),
    ]:
        _, client = stub(error=error)
        service = WordService(WordStore(tmp_path / f"{name}.json"), client_factory=lambda: client)

        async def run(http):
            reply = await http.post("/api/word", json={"text": "castle"})
            assert reply.status == 503
            assert expected in (await reply.json())["reason"]

        asyncio.run(with_client(service, run))
        assert service.store.all() == []


def test_start_up_line_names_the_model_and_never_the_key(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("GEMINI_API_KEY", "not-a-real-key-123")
    line = WordService(WordStore(tmp_path / "words.json")).describe()
    assert "Gemini" in line and "gemini-4-hydrogen" in line and "low" in line
    assert "not-a-real-key-123" not in line


def test_keys_file_fills_only_what_is_missing(tmp_path: Path, monkeypatch):
    for name in ("GEMINI_API_KEY", "ANTHROPIC_API_KEY", "DECK_WORD_MODEL", "DECK_WORD_EFFORT", "PATH_TEST"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("DECK_WORD_EFFORT", "high")  # set in the terminal: the file must not replace it
    path = tmp_path / "keys.env"
    path.write_text(
        "# a comment\n\nGEMINI_API_KEY=abc123\nexport DECK_WORD_MODEL=\"gemini-3.5-flash-lite\"\n"
        "ANTHROPIC_API_KEY=zzz\nGOOGLE_API_KEY=\nDECK_WORD_EFFORT=low\nPATH_TEST=/nope\nnot a line\n",
        encoding="utf-8",
    )
    assert words.load_keys(path) == ["GEMINI_API_KEY", "DECK_WORD_MODEL"]
    env = words.os.environ
    assert env["GEMINI_API_KEY"] == "abc123" and env["DECK_WORD_MODEL"] == "gemini-3.5-flash-lite"
    assert env["DECK_WORD_EFFORT"] == "high"
    assert "GOOGLE_API_KEY" not in env  # empty
    assert "ANTHROPIC_API_KEY" not in env and "PATH_TEST" not in env  # not names this server reads
    monkeypatch.delenv("GEMINI_API_KEY")  # load_keys wrote these itself: take them out again
    monkeypatch.delenv("DECK_WORD_MODEL")
    assert words.load_keys(tmp_path / "missing.env") == []

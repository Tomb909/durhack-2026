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
    monkeypatch.setattr(words, "EFFORT", "")
    monkeypatch.setattr(words, "HEDGE_AFTER", 4.0)


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
    "metres": 60,
    "count": "one",
    "habitat": "land",
    "motion": "still",
    "glow": False,
    "palette": ["#8f8a80", "#a83232"],
    "parts": [
        {"s": "box", "p": [0, 30, 0], "d": [50, 60, 50], "c": 0},
        {"s": "cylinder", "p": [25, 35, 25], "d": [15, 70, 15], "c": 0, "t": 85, "m": "xz"},
        {"s": "box", "p": [20, 62, 0], "d": [4, 5, 4], "c": 1, "r": [0, 45, 0], "n": 8},
    ],
}


class StubModels:
    """Stands in for `client.aio.models` (Gemini's generate_content)."""

    def __init__(self, reply: dict, ended: str = "STOP", error=None, delay=0.0, blocked: str | None = None) -> None:
        # `delay` and `error` may be lists: one entry per call, in order (the last one repeats).
        self.reply, self.ended, self.error, self.delay, self.blocked = reply, ended, error, delay, blocked
        self.calls: list[dict] = []
        self.cancelled = 0

    async def generate_content(self, **kwargs):
        nth = len(self.calls)
        self.calls.append(kwargs)
        pick = lambda v: v[min(nth, len(v) - 1)] if isinstance(v, list) else v
        try:
            await asyncio.sleep(pick(self.delay))
        except asyncio.CancelledError:
            self.cancelled += 1
            raise
        error = pick(self.error)
        if error:
            raise error
        return SimpleNamespace(
            text=json.dumps(self.reply),
            candidates=[SimpleNamespace(finish_reason=self.ended)],
            prompt_feedback=SimpleNamespace(block_reason=self.blocked),
        )


def stub(reply=REPLY, **kwargs) -> tuple[StubModels, object]:
    models = StubModels(reply, **kwargs)
    return models, SimpleNamespace(aio=SimpleNamespace(models=models))


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


def test_a_place_keeps_its_landforms_and_its_biome():
    """Shapes and the biome reach the store as the page reads them; "patch" and "" mean "none"."""
    card = card_from_reply("THE NETHER", {**REPLY, "has_object": False, "effects": [
        {"field": "height", "amount": -0.03, "radius": 0.22, "shape": "flat"},
        {"field": "lava", "amount": 1.0, "radius": 0.17, "shape": "flat"},
        {"field": "temperature", "amount": 0.8, "radius": 0.2, "shape": "patch"},
        {"field": "life", "amount": -1, "radius": 0.3, "shape": "teapot"},
        {"field": "seaLevel", "amount": 0.01, "radius": 0.3, "shape": "flat"},
        {"field": "wetness", "amount": -0.9, "radius": 0.3, "shape": "flat"},
        {"field": "height", "amount": 0.1, "radius": 0.3, "shape": "spires"},
    ], "ground_color": "#6e2a2e", "ground_strength": 0.95, "ground_radius": 0.32, "plant_color": "", "rock_color": "#4a1c20",
        "liquid_color": "#ff6a1a", "liquid_glow": 1.0, "keep_trees": False}, 5)
    assert card["effects"] == [
        {"field": "height", "amount": -0.03, "radius": 0.22, "shape": "flat"},
        {"field": "lava", "amount": 1.0, "radius": 0.17, "shape": "flat"},
        {"field": "temperature", "amount": 0.8, "radius": 0.2},
        {"field": "life", "amount": -1, "radius": 0.3},
        {"field": "seaLevel", "amount": 0.01, "global": True},
        {"field": "wetness", "amount": -0.9, "radius": 0.3, "shape": "flat"},
    ]  # six at most
    assert card["biome"] == {"ground": "#6e2a2e", "strength": 0.95, "radius": 0.32, "trees": False, "rock": "#4a1c20",
                             "liquid": {"color": "#ff6a1a", "glow": 1.0}}
    assert "ground" not in card
    plain = card_from_reply("CASTLE", REPLY, 5)["biome"]
    assert "liquid" not in plain and "plants" not in plain and plain["trees"] is True
    assert "lava" in CARD_SCHEMA["properties"]["effects"]["items"]["properties"]["field"]["enum"]


def test_parts_are_written_shortly_and_stored_plainly():
    prop = card_from_reply("CASTLE", REPLY, 10)["prop"]
    assert prop["metres"] == 60 and prop["scale"] == "landmark"
    keep, tower, merlon = prop["parts"]
    assert keep == {"shape": "box", "at": [0, 0.3, 0], "size": [0.5, 0.6, 0.5], "rotate": [0, 0, 0], "color": "#8f8a80"}
    assert tower["taper"] == 0.85 and tower["mirror"] == "xz" and "repeat" not in tower
    assert merlon["repeat"] == 8 and merlon["rotate"] == [0, 45, 0] and merlon["color"] == "#a83232"
    # Nonsense in a part is left for the page's gate to replace, never an error here.
    odd = card_from_reply("X", {**REPLY, "metres": "big", "parts": [{"s": "box", "p": "no", "d": [1], "c": 9, "m": "y", "n": True}, 7]}, 1)["prop"]
    assert odd["scale"] == "medium" and "metres" not in odd
    assert odd["parts"] == [{"shape": "box", "at": [0, 0, 0], "size": [0.01, 0.2, 0.2], "rotate": [0, 0, 0], "color": ""}]


def test_schema_is_strict_everywhere():
    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "object":
                assert node["additionalProperties"] is False
                # Everything is required except what a part may leave out to stay short.
                optional = {"r", "t", "m", "n"} if "s" in node["properties"] else set()
                assert set(node["required"]) == set(node["properties"]) - optional
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(CARD_SCHEMA)
    assert "<word>" in PROMPT


def test_forgets_every_stored_card(tmp_path: Path):
    messages, client = stub()
    path = tmp_path / "words.json"
    service = WordService(WordStore(path), client_factory=lambda: client)

    async def run(http):
        await http.post("/api/word", json={"text": "castle"})
        assert path.exists()
        forgot = await http.delete("/api/words")
        assert forgot.status == 200 and (await forgot.json()) == {"removed": 1}
        assert not path.exists()
        assert (await (await http.get("/api/words")).json()) == {"cards": []}
        # Nothing left to forget is not an error, and the word is read afresh afterwards.
        assert (await (await http.delete("/api/words")).json()) == {"removed": 0}
        return await (await http.post("/api/word", json={"text": "castle"})).json()

    again = asyncio.run(with_client(service, run))
    assert again["source"] == "model" and len(messages.calls) == 2


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
    assert call["model"] == words.DEFAULT_MODEL == "gemini-3.5-flash-lite" and call["contents"] == "<word>CASTLE</word>"
    config = call["config"]
    assert config["system_instruction"] == PROMPT
    assert config["response_mime_type"] == "application/json" and config["response_json_schema"] == CARD_SCHEMA
    assert config["http_options"] == {"timeout": 45000}  # milliseconds
    # No thinking level unless one is asked for: the model's own default is the fastest.
    assert "thinking_config" not in config and "temperature" not in config
    slow = WordService(WordStore(tmp_path / "other.json"), client_factory=lambda: client, effort="high")
    assert slow._config()["thinking_config"] == {"thinking_level": "high"}


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


def test_an_unfinished_or_declined_answer_is_no_card(tmp_path: Path):
    for ended in ("MAX_TOKENS", "FinishReason.SAFETY", "RECITATION"):
        models, client = stub(ended=ended)
        service = WordService(WordStore(tmp_path / f"{ended}.json"), client_factory=lambda: client)
        with pytest.raises(Unavailable, match="did not finish"):
            asyncio.run(service.resolve("castle"))
        assert len(models.calls) == 1  # it would end the same way again
        assert not (tmp_path / f"{ended}.json").exists()
    _, client = stub(blocked="SAFETY")
    service = WordService(WordStore(tmp_path / "blocked.json"), client_factory=lambda: client)
    with pytest.raises(Unavailable, match="declined"):
        asyncio.run(service.resolve("castle"))


def test_an_overloaded_model_is_asked_again_at_once(tmp_path: Path):
    # About three asks in ten get "503: this model is overloaded" straight back; the next ask usually works.
    overloaded = Carrying("This model is currently experiencing high demand.", code=503, status="UNAVAILABLE")
    models, client = stub(error=[overloaded, overloaded, None])
    service = WordService(WordStore(tmp_path / "words.json"), client_factory=lambda: client)
    seconds = asyncio.run(_timed(service.resolve("castle")))
    assert seconds < 1.0 and len(models.calls) == 3
    assert service.store.get("castle") is not None


def test_a_model_that_stays_overloaded_gives_up_after_a_few_asks(tmp_path: Path):
    overloaded = Carrying("This model is currently experiencing high demand.", code=503, status="UNAVAILABLE")
    models, client = stub(error=overloaded)
    service = WordService(WordStore(tmp_path / "words.json"), client_factory=lambda: client)
    with pytest.raises(Unavailable, match="overloaded"):
        asyncio.run(service.resolve("castle"))
    assert len(models.calls) == words.MOST_ASKS
    assert service.store.all() == []


def test_slow_model_times_out(tmp_path: Path):
    _, client = stub(delay=1.0)
    service = WordService(WordStore(tmp_path / "words.json"), client_factory=lambda: client, timeout=0.05)
    with pytest.raises(Unavailable, match="no answer"):
        asyncio.run(service.resolve("castle"))


def test_a_late_answer_is_asked_for_again_and_the_first_to_come_wins(tmp_path: Path):
    # The first ask stalls (it happens about one time in four); the second, sent alongside, answers at once.
    models, client = stub(delay=[5.0, 0.01])
    service = WordService(WordStore(tmp_path / "words.json"), client_factory=lambda: client, hedge_after=0.05)
    started = asyncio.run(_timed(service.resolve("castle")))
    assert started < 1.0  # not the five seconds of the stalled ask
    assert len(models.calls) == 2 and service.calls == 2
    assert models.cancelled == 1  # the stalled ask was called off, not left running
    assert service.store.get("castle") is not None


async def _timed(job) -> float:
    loop = asyncio.get_running_loop()
    started = loop.time()
    await job
    await asyncio.sleep(0)  # let a called-off ask finish being cancelled
    return loop.time() - started


def test_a_prompt_answer_is_asked_for_once(tmp_path: Path):
    models, client = stub(delay=0.01)
    service = WordService(WordStore(tmp_path / "words.json"), client_factory=lambda: client, hedge_after=0.2)
    asyncio.run(service.resolve("castle"))
    assert len(models.calls) == 1


def test_a_plain_failure_is_not_asked_again(tmp_path: Path):
    # A refused key will be refused the second time too: say so at once.
    for name, error, said in [
        ("refused", Carrying("no", code=403, status="PERMISSION_DENIED"), "key was refused"),
        ("quota", Carrying("quota", code=429, status="RESOURCE_EXHAUSTED"), "rate limited"),
        ("wrong-model", Carrying("models/nope is not found", code=404, status="NOT_FOUND"), "404"),
    ]:
        models, client = stub(error=error)
        service = WordService(WordStore(tmp_path / f"{name}.json"), client_factory=lambda: client, hedge_after=0.05)
        with pytest.raises(Unavailable, match=said):
            asyncio.run(service.resolve("castle"))
        assert len(models.calls) == 1, name


def test_one_of_two_failing_leaves_the_other(tmp_path: Path):
    # Both are out; the first then fails, the second answers.
    models, client = stub(delay=[0.15, 0.2], error=[OSError("reset"), None])
    service = WordService(WordStore(tmp_path / "words.json"), client_factory=lambda: client, hedge_after=0.05)
    card, source = asyncio.run(service.resolve("castle"))
    assert source == "model" and card["id"] == "castle"
    assert 2 <= len(models.calls) <= words.MOST_ASKS  # the failed one was replaced; late ones may have been added


def test_both_failing_is_no_card_and_both_slow_is_a_timeout(tmp_path: Path):
    models, client = stub(delay=0.02, error=OSError("reset"))
    service = WordService(WordStore(tmp_path / "a.json"), client_factory=lambda: client, hedge_after=0.05)
    with pytest.raises(Unavailable, match="could not reach"):
        asyncio.run(service.resolve("castle"))
    assert len(models.calls) == words.MOST_ASKS
    models, client = stub(delay=5.0)
    service = WordService(WordStore(tmp_path / "b.json"), client_factory=lambda: client, hedge_after=0.05, timeout=0.3)

    async def run():
        with pytest.raises(Unavailable, match="no answer"):
            await service.resolve("castle")
        await asyncio.sleep(0)
        return models.cancelled

    assert asyncio.run(run()) == words.MOST_ASKS == len(models.calls)  # giving up calls every ask off
    assert service.store.all() == []


def test_asking_again_can_be_turned_off(tmp_path: Path):
    models, client = stub(delay=0.15)
    service = WordService(WordStore(tmp_path / "words.json"), client_factory=lambda: client, hedge_after=0)
    asyncio.run(service.resolve("castle"))
    assert len(models.calls) == 1


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
    assert "overloaded" in why_not(Carrying("high demand", code=503, status="UNAVAILABLE"))
    # Which failures are of the moment (ask again) and which are the answer (do not).
    again = words.worth_asking_again
    assert again(Carrying("high demand", code=503, status="UNAVAILABLE")) and again(Carrying("oops", status_code=500))
    assert again(OSError("no route")) and again(asyncio.TimeoutError())
    assert not again(Carrying("no", code=403)) and not again(Carrying("quota", code=429)) and not again(Carrying("bad", code=400))
    assert not again(TypeError("a mistake in the ask itself"))
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
    # generate_content's own "overloaded", as the SDK raises it.
    busy = errors.ServerError(503, {"error": {"code": 503, "message": "This model is currently experiencing high demand.", "status": "UNAVAILABLE"}})
    assert "overloaded" in why_not(busy) and words.worth_asking_again(busy)


def test_failures_are_no_card(tmp_path: Path):
    for name, error, expected in [
        ("quota", Carrying("quota", status_code=429), "rate limited"),
        ("refused", Carrying("no", status_code=403), "key was refused"),
        ("offline", OSError("no route"), "could not reach"),
        ("overloaded", Carrying("high demand", code=503, status="UNAVAILABLE"), "overloaded"),
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
    assert "Gemini" in line and words.DEFAULT_MODEL in line and "thinking" not in line
    assert "high thinking" in WordService(WordStore(tmp_path / "w.json"), effort="high").describe()
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

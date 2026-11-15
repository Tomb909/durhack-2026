"""Probe: how long does a new word take to become a card, and what kind of card comes back?

Resolves each word through the real endpoint (POST /api/word on a running `uv run deck`),
one after another, and writes per word: seconds taken, where the card came from, what
kind of card it is, and the reading. Then prints the harness command that draws them.

    uv run python tools/word_probe.py                      the standard list of about 20 words
    uv run python tools/word_probe.py castle "haunted house"
    uv run python tools/word_probe.py --fresh              ask the model again even for stored words
    uv run python tools/word_probe.py --url http://127.0.0.1:8010

Every new word is one model call, which costs money. Results go to .deck/probe.json.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Spread across kinds: boxy things, organic things, places, weather and time, abstract words,
# a phrase, a misspelling and a word in another script.
WORDS = [
    "castle", "lighthouse", "boat", "bridge",
    "cow", "dragon", "tree", "person",
    "swamp", "volcano", "desert", "canyon",
    "fog", "night", "storm",
    "jazz", "sadness", "hope",
    "haunted house", "volcanoe", "火山",
]


def kind_of(card: dict) -> str:
    """Which of the three things the card does, in a few words."""
    parts = []
    if card.get("effects"):
        parts.append("land")
    air = card.get("atmosphere") or {}
    if (air.get("strength") or 0) > 0 or (air.get("light") or 0) != 0 or air.get("particles"):
        parts.append("air")
    prop = card.get("prop")
    if prop:
        parts.append(f"object ({prop.get('count')}, {prop.get('scale')}, {prop.get('habitat')}, {len(prop.get('parts', []))} parts)")
    return " + ".join(parts) or "nothing"


def ask(url: str, word: str, fresh: bool) -> tuple[int, dict]:
    request = urllib.request.Request(
        f"{url}/api/word", data=json.dumps({"text": word, "fresh": fresh}).encode(), headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("words", nargs="*", help="words to try (default: the standard list)")
    parser.add_argument("--url", default="http://127.0.0.1:8000", help="the deck server")
    parser.add_argument("--fresh", action="store_true", help="ask the model again even for stored words")
    args = parser.parse_args()
    words = args.words or WORDS

    rows = []
    for word in words:
        started = time.monotonic()
        try:
            status, body = ask(args.url, word, args.fresh)
        except (urllib.error.URLError, OSError) as error:
            sys.exit(f"Could not reach {args.url}: {error}. Start the server with `uv run deck`.")
        seconds = time.monotonic() - started
        if status == 200:
            card = body["card"]
            row = {"word": word, "id": card["id"], "seconds": round(seconds, 2), "source": body["source"],
                   "kind": kind_of(card), "reading": card.get("reading", "")}
        else:
            row = {"word": word, "id": None, "seconds": round(seconds, 2), "source": f"none ({status})",
                   "kind": "-", "reading": body.get("reason", "")}
        rows.append(row)
        print(f"{row['seconds']:6.2f} s  {row['source']:<10} {word:<16} {row['kind']}\n          {row['reading']}", flush=True)

    made = [r["seconds"] for r in rows if r["source"] == "model"]
    if made:
        print(f"\nNew words: {len(made)}; seconds each min {min(made):.1f}, median {statistics.median(made):.1f}, max {max(made):.1f}")
    out = ROOT / ".deck" / "probe.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({"url": args.url, "rows": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Saved {out}")
    ids = [r["id"] for r in rows if r["id"]]
    if ids:
        print("\nDraw them:")
        print(f"  npm --prefix web run harness -- {' '.join(dict.fromkeys(ids))} --shots --tile 500 --cols 5")


if __name__ == "__main__":
    main()

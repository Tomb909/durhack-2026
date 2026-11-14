# Deck of Worlds

Handwritten word cards on a table, watched by a phone, reshape a 3D world on a laptop. DurHack 2026.

## Run it

Needs [uv](https://docs.astral.sh/uv/) and Node.js.

```bash
uv sync
```

```bash
uv run deck
```

Then on the laptop open <http://localhost:8000>. The terminal prints the address for the phone, and the page shows it as a QR code.

### Connecting the phone

1. Turn on the iPhone's Personal Hotspot and join it from the laptop (venue Wi-Fi often blocks devices from seeing each other).
2. The first time, Windows asks whether to let Python through the firewall: allow it on **Public** networks.
3. Scan the QR code. Safari warns about the certificate: Show Details → visit this website.
4. Tap **Start camera** and prop the phone 40–60 cm above the sheet with the whole border in view. The banner turns green: "Play area found ✓".

If Safari refuses the camera, the phone page shows how to install the local certificate (one time).

### Useful extras

| Command | What it does |
|---|---|
| `uv run deck --source synth` | Fake camera frames with moving cards, no phone needed |
| `uv run deck --record recordings/run1` | Save about 3 camera frames a second |
| `uv run deck --source replay:recordings/run1` | Play saved frames back through tracking |
| `uv run python tools/spike_read.py recordings/snaps` | Report how well saved frames are read |
| `uv run pytest` | Vision tests on synthetic frames |

<http://localhost:8000/debug> shows the camera view, the top-down view with detections, and a card check table.

## Making cards

- Thick black marker, BLOCK CAPITALS, letters 1.5–2.5 cm tall, one word per scrap.
- Plain white paper with a finger-width of blank margin around the word. Nothing else on the scrap.
- The five words: MOUNTAIN, WATER, SUN, ICE, LIFE. Make several of each.
- Copies go side by side, never stacked.

The play area is one closed rectangle drawn with the thick marker on an A3 sheet, 1.5–2 cm in from the edge.

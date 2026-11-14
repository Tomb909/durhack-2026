# Deck of Worlds

Handwritten word cards on a table, watched by a phone, reshape a 3D world on a laptop. DurHack 2026.

Put **MOUNTAIN** in a corner and mountains rise there. Add **WATER** and it rains; add more and the sea floods the lowlands. **ICE** beside the mountains snows the peaks, **SUN** dries a desert, and **LIFE** grows forest only where it is warm and wet enough. The world comes from how the cards combine.

## Run it

Needs [uv](https://docs.astral.sh/uv/) and [Node.js](https://nodejs.org/). First time only:

```bash
uv sync
```

```bash
npm --prefix web install
```

```bash
npm --prefix web run build
```

Every time:

```bash
uv run deck
```

Open <http://localhost:8000> on the laptop. Press **G** for the setup guide.

### Connecting the phone (under a minute)

1. Turn on the phone's Personal Hotspot and join it from the laptop. Venue Wi-Fi often stops devices seeing each other.
2. Press **P** on the world page and scan the QR code with the phone.
3. The first time, Safari warns about the certificate: Show Details → visit this website. Windows may also ask about the firewall: allow Python on **Public** networks.
4. Tap **Start camera**. Prop the phone 40–60 cm above the sheet with the whole sheet in view and a little table showing on every side. The banner turns green: "Play area found ✓".

Nothing needs the internet once it is running.

### Keys on the world page

| Key | Does |
|---|---|
| G | Setup guide |
| C | Card check: what the camera reads on each scrap |
| P | Phone connection (QR code) |
| F | Fullscreen |
| R | Rotate the table 180° (if near and far are swapped) |
| L | Find the border again |
| B | Show or hide the card labels |
| Tab | Developer option: the table map and the tray of simulated cards |
| X | Remove all simulated cards |
| I | Instant: no fading or easing, the world jumps to its final state |
| H | Hide the panels |
| Q | Picture quality |

### Simulated cards

A developer option, hidden by default: press **Tab** to show the table map and a tray of cards. Drag a card from the tray onto the map, or straight onto the world. Drag it off to remove it. They add to whatever the camera sees. If the camera drops out, the tray appears by itself and the real cards stay where they were and become draggable, with no restart.

## Making cards and the sheet

- **Sheet:** A3 (or two A4s taped flat). Draw one closed rectangle with a thick black marker, a finger-width in from the edge.
- **Cards:** one word per scrap of plain white paper, BLOCK CAPITALS, thick black marker, letters 1.5–2.5 cm tall and close together, blank margin all round. Nothing else on the scrap.
- **Words:** MOUNTAIN, WATER, SUN, ICE, LIFE. Make several of each.
- **Copies** go side by side, never stacked. Turning a card does nothing.

## If something goes wrong

| Symptom | Fix |
|---|---|
| Phone says the connection was lost | Make sure the address starts with `https://` (the server redirects `http://` too), and that both devices are on the hotspot |
| Banner stays amber, "Looking for the black border" | Get the whole sheet in view with table visible on all four sides; make the border line thicker and closed |
| A card shows "?" | Rewrite it larger, in capitals, with a thicker pen; check it with **C** |
| Left and right are swapped | Press **R** |
| Camera fails mid-demo | Carry on with the mouse: the cards are still there and draggable |

## How it fits together

```
phone (camera page) ── JPEG frames over HTTPS ──► server/deck  (Python: find sheet, find ink, read words, track)
                                                      │ card list over WebSocket
                                                      ▼
web/src/cards (smoothing) ─► web/src/sim (world rules, no graphics) ─► web/src/render (Three.js picture)
```

- `web/src/cards/cards.json` defines the cards as data: a word, an icon, and what it pushes on (height, temperature, wetness, life, sea level). A new card is a new entry.
- `web/src/sim/world.ts` holds every rule and every tunable number (`RULES`). Nothing in it knows about graphics.
- `web/src/render/` only draws. It receives the world as two textures and can be restyled freely; `palette.ts` holds the climate colours.
- `server/deck/vision/` is the tracking: `playarea.py`, `detect.py`, `reader.py`, `tracker.py`.

### Developing

| Command | What it does |
|---|---|
| `npm --prefix web run dev` | World page with hot reload at <http://localhost:5173> (talks to the server on 8000) |
| `npm --prefix web test` | World-rule tests |
| `npm --prefix web run harness` | Every card combination as numbers, and as a picture sheet with `--shots` (see below) |
| `uv run pytest` | Tracking tests on synthetic frames |
| `uv run deck --source synth` | Fake camera with moving cards, no phone needed |
| `uv run deck --record recordings/run1` | Save about 3 camera frames a second |
| `uv run python tools/replay_report.py recordings/run1` | Replay saved frames through tracking |

<http://localhost:8000/debug> shows the raw camera view and the top-down view with detections.

### No phone, no word reader

The world page needs nothing but itself. `npm --prefix web run dev` and open <http://localhost:5173>: the status reads "Simulated cards". Press **Tab** for the card tray and drag cards onto the world. The Python server is only for the camera; `uv run deck --no-read` starts it without loading the word reader.

Cards can also come from the address, already settled, with no dragging and no waiting:

| Address | Does |
|---|---|
| `/?cards=life+water+sun` | Start with these cards in place |
| `/?cards=water*3+life@0.8,0.6` | Copies, and a card at a table position (x left to right, y far to near, 0..1) |
| `&instant` | No fading or easing for anything you do afterwards (same as **I**) |
| `&still=6` | Freeze the picture at second 6: no camera sway, rain stopped mid-fall |

In the browser console, `deck.set('mountain+ice')` swaps the cards at once.

### Harness: every combination, at once

The same cards always settle to the same world, so there is no need to place cards and wait. The harness jumps each world straight to its settled state (about 10 ms) and draws it at one fixed moment.

**Numbers only** (no browser, under a second for every combination):

```bash
npm --prefix web run harness -- --set subsets
```

One line per world: sea level, highest peak, and the share of the map that is flooded, river or lake, raining, snowing, forest, frozen, desert, plus a fingerprint of the whole world. To see what a rule change did:

```bash
npm --prefix web run harness -- --set all --baseline
```

```bash
npm --prefix web run harness -- --set all --diff
```

**Pictures** (one sheet of small tiles, drawn by headless Chrome in about two seconds):

```bash
npm --prefix web run harness -- --set subsets --shots --view both
```

The sheet and its numbers land in `.deck/harness/` (`sheet.jpg`, `metrics.json`). With the dev server running, the same sheet is a page: <http://localhost:5173/harness.html?set=subsets&view=both>. Add `&save=1` to write the files.

| Option (command line / address) | Meaning |
|---|---|
| `"water*3" "life+sun"` / `c=water*3;life+sun` | Your own combination codes, one world each. `name=code` names one. |
| `--set` / `set=` | `showcase` (default), `singles`, `pairs`, `subsets` (all 32), `copies` (each card ×1 to ×3), `all`. Comma separated. |
| `--layout` / `layout=` | Where cards without a position go: `cluster` (together, default) or `spread` (each kind apart) |
| `--view` / `view=` | `3d`, `map` (flat top-down, no GPU needed), `both` (3D with a map inset) |
| `--tile` / `tile=` | Tile width in pixels (default 400). `--tile 1200 --cols 1` for a close look at a few worlds. |
| `--cols`, `--time`, `--zoom` / `cols=`, `t=`, `zoom=` | Tiles per row, the moment drawn (default 6 s), how close the camera is (default 1.3) |
| `--no-beacons`, `--png`, `--tiles` / `beacons=0`, `fmt=png`, `tiles=1` | Hide the card pillars, lossless files, one file per world as well |

Combination codes: card ids joined by `+` (or `_`), `*3` for copies, `@x,y` for a position, and any unambiguous start of an id (`m+w*2`). Ids come from `cards.json`, so a new card works in codes and in every set straight away. Chrome is found automatically; set `CHROME_PATH` if it is somewhere unusual, or use `--serve` to open the sheet in a browser yourself.

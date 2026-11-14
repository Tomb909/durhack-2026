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
| V | Combinations: every mix of cards side by side (also the button, top right) |
| X | Remove all simulated cards |
| W A S D | Move the view; hold Shift to go faster |
| Arrows, + −, 0 | Turn the view, zoom, reset it (see Moving the camera) |
| T | Developer option: step through play-area shapes (rectangle, circle, blob) when no camera is connected |
| I | Instant: no fading or easing, the world jumps to its final state |
| H | Hide the panels |
| Q | Picture quality: the sharpest it may be (see Staying smooth) |

### Moving the camera

Left alone, the view sways gently from side to side. Touch it and it is yours: a single click is enough to stop the sway.

| To | Mouse | Trackpad (Mac and others) | Touch screen | Keys |
|---|---|---|---|---|
| Turn the view | Drag | Two-finger scroll, or click and drag | One finger | Arrow keys |
| Zoom, toward the pointer | Wheel | Pinch, or ⌘/Ctrl + two-finger scroll | Pinch | **+** and **−** |
| Move the view | Right-drag, middle-drag, or Shift + drag | Shift + two-finger scroll, or Shift + drag | Two fingers | **W A S D**, with Shift to go faster |
| Back to the usual view | Double-click | Double-click | | **0** |

A **Reset view** button also appears at the top right whenever the view has been moved; resetting brings the sway back. Pressing on a simulated card still picks the card up rather than turning the view. On a Mac, an ordinary mouse wheel can look like a trackpad to the browser: if the wheel tilts the view instead of zooming, hold ⌘ while you scroll.

### Simulated cards

A developer option, hidden by default: press **Tab** to show the table map and a tray of cards. Drag a card from the tray onto the map, or straight onto the world. Drag it off to remove it. They add to whatever the camera sees. If the camera drops out, the tray appears by itself and the real cards stay where they were and become draggable, with no restart.

Place **BIG** near the card it modifies, on any side, with their centers no more than 30% of the table width apart. The nearest card is modified, and the table map marks it with **+BIG**. BIG increases that card's local area of influence by 1.5×; on MOUNTAIN, it also makes the height effect 1.5× stronger. Multiple BIG cards stack. Global effects such as WATER's sea-level rise are unchanged.

## Making cards and the sheet

- **Sheet:** A3 (or two A4s taped flat). Draw one closed rectangle with a thick black marker, a finger-width in from the edge.
- **Cards:** one word per scrap of plain white paper, BLOCK CAPITALS, thick black marker, letters 1.5–2.5 cm tall and close together, blank margin all round. Nothing else on the scrap.
- **Words:** BIG, MOUNTAIN, WATER, SUN, ICE, LIFE. Make several of each.
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
- The sky follows the world. `web/src/render/mood.ts` reads four numbers off the world (how hot, cold, wet and alive it is) and `backdrop.ts` paints from them: amber dusk over a hot world, teal and aurora over a frozen one, grey overcast in the rain, green and fireflies where things grow.
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

### Staying smooth

The picture looks after its own frame rate, and two rules keep it that way as cards are added.

**It gives up sharpness before it gives up smoothness.** When frames stay slow for about a second, the world is drawn with fewer pixels (softer, otherwise the same); when there has been time to spare for a while, they come back. **Q** sets the sharpest it may be. `deck.view.autoQuality = false` in the console turns this off, and `deck.view.pixelRatio` says what it is drawing at now. The harness and the Combinations view always draw at their full, fixed size.

**Only what can be showing is drawn.** Trees, houses, people, sheep, boats and smoke each stand at thousands of fixed sites, and the GPU works out every one from the world's textures. Before a changed world is drawn, the sites with nothing to show are left out (`web/src/render/sites.ts`): an empty world draws none of them. `deck.view.sitesDrawn` gives the count. Anything new that stands at sites should do the same:

- Build it with `Sites` and give it a test that says whether a site *could* be showing. The test must be safe rather than exact: it may keep a site the shader then hides, never drop one the shader would show. Ask `world.most(field, x, y, wander)` for the largest value near the site and compare it with the same threshold the shader uses; keep that threshold as one constant shared by both (see the top of `people.ts`).
- `deck.view.cull = false` draws every site again. The picture must not change by a single pixel: if it does, a test is too strict.
- Weld shapes with `mergeVertices` after merging them, so corners shared by several triangles are worked out once.

The rules of the world (`web/src/sim/`) keep two shortcuts worth knowing when adding to them: the climb inland that decides where water drains is only repeated when the ground or the sea has changed (`Hydrology.compute`), and a card's round patch of influence is worked out from one row and one column, not cell by cell (`addCopies`). `npm --prefix web run harness -- --set all --diff` shows at once whether a change meant to be a pure speed-up moved any world.

### Harness: every combination, at once

The same cards always settle to the same world, so there is no need to place cards and wait. The harness jumps each world straight to its settled state (about 10 ms) and draws it at one frozen moment. There are three ways in: a view inside the app for looking, a command for numbers, and a picture sheet for files.

#### Combinations view (in the app)

Press the **Combinations** button at the top right of the world page, or **V**. It works on the built page (`uv run deck`) and the dev page alike; `/?combos` in the address opens it straight away. **Esc** closes it.

Every combination of the cards appears as a tile, with what is on the table and the main numbers underneath (share of the map that is sea, rain, forest and so on). One row of controls along the top:

| Control | Does |
|---|---|
| **A switch per card** | Switch a card off to leave it out, on to bring it back. The view shows every combination of the cards that are on: six cards is 64 worlds, five is 32. A modifier card such as BIG starts switched off, because it only changes the card beside it. The number beside the title is how many are showing. |
| **− ×1 +** beside a card | How many copies of that card, wherever it appears, from 1 to 3. Three Waters flood the lowlands; three Mountains make a far taller range. |
| **3D / Map / Both** | The world as the app draws it, flat from above (nothing hidden behind clouds), or 3D with the map in the corner. |
| **S / M / L** | Tile size: small to see many at once, large to look closely. |

Each tile with two or more kinds of card has its own **Spaced** switch in its top right corner. It places those cards apart instead of on the same ground, for that tile only, so you can see where they meet.

Click a tile (or Tab to it and press Enter) to see it large with all its numbers. There, **←** and **→** step through the combinations, **Show in the live world** puts those cards on the real table so you can move them, and **Esc** goes back. The **✕** at the top right (or **Esc** again) closes the view. The card switches, copies, picture and tile size are remembered for next time; changing them never moves your place in the list.

#### Numbers from the command line

No browser, under a second for every combination:

```bash
npm --prefix web run harness -- --set subsets
```

One line per world: sea level, highest peak, and the share of the map that is flooded, river or lake, raining, snowing, forest, frozen, desert, plus a fingerprint of the whole world. To see what a rule change did, save the numbers before and compare after:

```bash
npm --prefix web run harness -- --set all --baseline
```

```bash
npm --prefix web run harness -- --set all --diff
```

#### Picture sheet as a file

One image of small tiles, drawn by headless Chrome in about two seconds (handy for sharing, or for an AI assistant to look at):

```bash
npm --prefix web run harness -- --set subsets --shots --view both
```

The sheet and its numbers land in `.deck/harness/` (`sheet.jpg`, `metrics.json`). With the dev server running, the same sheet is a page: <http://localhost:5173/harness.html?set=subsets&view=both>. Add `&save=1` to write the files.

| Option (command line / address) | Meaning |
|---|---|
| `"water*3" "life+sun"` / `c=water*3;life+sun` | Your own combination codes, one world each. `name=code` names one. |
| `--set` / `set=` | `showcase` (default), `singles`, `pairs`, `subsets` (every mix of the cards, 64 with six cards), `copies` (each card ×1 to ×3), `all`. Comma separated. |
| `--layout` / `layout=` | Where cards without a position go: `cluster` (together, default) or `spread` (each kind apart) |
| `--view` / `view=` | `3d`, `map` (flat top-down, no GPU needed), `both` (3D with a map inset) |
| `--tile` / `tile=` | Tile width in pixels (default 400). `--tile 1200 --cols 1` for a close look at a few worlds. |
| `--cols`, `--time`, `--zoom` / `cols=`, `t=`, `zoom=` | Tiles per row, the moment drawn (default 6 s), how close the camera is (default 1.3) |
| `--az`, `--el` / `az=`, `el=` | Look from this many degrees round the world, and this many above the table (default 0 and 37). `--zoom 0.45 --el 14 --az 35` shows the whole depth of the world from the side. |
| `--no-beacons`, `--png`, `--tiles` / `beacons=0`, `fmt=png`, `tiles=1` | Hide the card pillars, lossless files, one file per world as well |

Combination codes: card ids joined by `+` (or `_`), `*3` for copies, `@x,y` for a position, and any unambiguous start of an id (`m+w*2`). Ids come from `cards.json`, so a new card works in codes and in every set straight away. Chrome is found automatically; set `CHROME_PATH` if it is somewhere unusual, or use `--serve` to open the sheet in a browser yourself.

#### Keeping the harness current

- **A new card** in `cards.json` needs nothing: it gets its own switch in the Combinations view, joins every set, and works in codes.
- **A new thing the world can have** (a new array on the world's frame in `sim/world.ts`): add it to `measure()` in `web/src/harness/metrics.ts` so the fingerprint covers it, give it a number there if it is worth comparing (`METRIC_KEYS` and `METRIC_LABELS`), and a colour in `web/src/harness/map.ts`.
- **A modifier card** (one with `modifier` in `cards.json`, like BIG) is left out of the ready-made sets and starts switched off in the Combinations view. Write it in a code to see it: `big+mountain`.
- **Things that build up over time** are not in the harness, which shows each world the moment it settles. Woodcutters' felled forest (`cleared`) is the one so far.
- **A change to how the app draws** shows up in the tiles by itself: they use the app's own renderer. Anything drawn as a page element rather than in the 3D picture (the card labels, for one) does not appear in tiles.
- `npm --prefix web test` checks that the settled world depends on the cards alone and that the animated world ends up there. If a rule change breaks that, the harness would stop matching the app.

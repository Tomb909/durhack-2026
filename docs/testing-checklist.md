# Testing checklist: what this branch has that main does not

Branch `claude/user-generated-phrases-prototype-7aeebe`, 14 November 2026. It holds everything on `origin/main` (merchants, wind, sound, SETTLEMENT, the fixed play area) plus four things main does not have:

1. An engine review: crash fixes and speed.
2. Lava, ravine and volcano cards.
3. Any word becomes a card, read by Gemini.
4. The joins between those and main (wind and lava together, the SETTLEMENT rename, the new villages).

Tick each item, or write what you saw. Items marked **not yet checked by anyone** were only covered by automated tests or not at all.

## Setting up

```bash
npm --prefix web ci
```

```bash
npm --prefix web run dev
```

Open <http://localhost:5173>. For word cards read by the model, also run `uv run deck` in another terminal; the key lives in `~/.config/deck-of-worlds/keys.env` as `GEMINI_API_KEY=...`.

Useful while testing: **Tab** opens the card tray, **V** the Combinations view, **X** clears simulated cards, **T** changes the table shape, **I** is instant mode. In the browser console, `deck.set('mountain+lava+rain*2')` puts cards down at once.

## 0. Automated checks

- [ ] `npm --prefix web test` passes (136 tests, about 9 seconds).
- [ ] `uv run pytest server/tests -q` passes (59 tests).
- [ ] `npm --prefix web run build` builds.

## 1. Engine review

### Things that used to freeze or break the page

- [ ] **Three copies in a row.** Put RAIN at the left, RAIN at the right (a hand's width apart), a third RAIN between them, then any fourth card. Expected: one label "RAIN ×3" and the picture keeps moving. Before: the picture froze until reload.
- [ ] **A struggling machine.** In Chrome's Performance tab set CPU throttling to 6× or 20×, then drag a card. Expected: the card still glides to the pointer and stops. Before: under about 13 frames a second, cards flew off the table and the page never recovered.
- [ ] **A frame that fails does not stop the picture.** In the console run `deck.view.render = () => { throw new Error('test') }`. Expected: one error in the console, the page stays responsive. Reload afterwards.

### Only what shows is drawn

- [ ] **Nothing is missing.** For each of these, look for trees, houses, chimney smoke, people, sheep, boats, rain, snow and clouds where you expect them: `forest+rain`, `ice+forest+rain`, `sun+forest+rain*2`, `civilization+rain+forest`, `civilization+lake` (boats), `ice+rain*2`.
- [ ] **Culling changes nothing.** With `civilization+lake+forest+wind` on the table, run `deck.view.cull = false` in the console, then `deck.view.cull = true`. Expected: the picture does not change at all either way. **Not yet checked by anyone since wind was merged** (boats are now pushed by the wind, and the culling was widened to match).
- [ ] `deck.view.sitesDrawn` on an empty table reports `drawn` near 0 out of about 20,000.

### Auto quality

- [ ] On a slow machine (or with the GPU throttled), the picture goes softer after a second or two of slow frames and sharpens again later. `deck.view.pixelRatio` shows the current value.
- [ ] **A 30 frames-a-second cap** (macOS Low Power Mode, or a 30 Hz screen). Expected: the picture may dip soft for a few seconds once, then returns to sharp and stays. Before the fix it dropped to its softest and stayed. **Not yet checked on a real capped screen.**
- [ ] **Q** cycles quality and the picture is sharp again at once. `deck.view.autoQuality = false` takes effect immediately.

### Table shapes and the Combinations view

- [ ] Press **T** until the table is a circle. Put a word card with an object and a couple of built-in cards down. Open Combinations (**V**) and close it. Expected: objects, labels and pillars are still in the right places, and dragging a card still lands it under the pointer. Before: they shifted to about 0.7 of their depth.
- [ ] Changing the table shape (**T**) does not stall for a noticeable time.

### Smoothness (by eye)

- [ ] **Not yet checked by anyone on a real screen:** with a normal mix of 6 to 10 cards the picture holds the screen's frame rate while idle and while dragging a card that does not move the ground (SUN, FOREST, VILLAGE).
- [ ] Dragging MOUNTAIN, RAVINE or a volcano (MOUNTAIN next to LAVA) is the heaviest case. Note the frame rate on the demo laptop.

## 2. Lava, ravine and volcano

- [ ] **LAVA** alone: a glowing pool with dark crust, smoke and embers over it, ash on the ground around.
- [ ] **MOUNTAIN next to LAVA** (`mountain+lava`): a volcano between the two cards, a cone with a crater, lava running down gullies, a smoke column. **Not yet checked with real cards:** slide LAVA slowly towards MOUNTAIN from the far side of the table: the mountain grows into the volcano with no jump, and slides back the same way.
- [ ] MOUNTAIN and LAVA far apart: a mountain, and a pool of lava by itself.
- [ ] **RAVINE** alone: a narrow crack, not a round pit. `ravine+rain`: it stays dry until rain runs into it, then holds a lake.
- [ ] `lava+lake` and `mountain+lava+lake`: lava under water sets to dark rock.
- [ ] `lava+ice`: lava in the cold cools to rock.
- [ ] `mountain+lava+forest+civilization`: forest is burnt back from the lava; nobody builds or farms on it.
- [ ] **The live world matches the Combinations view.** Put LAVA down by hand and wait ten seconds; compare with the `lava` tile. They should look the same (lava used to stop slightly short when placed live).
- [ ] Remove the lava card: the lava and its smoke go completely.
- [ ] Known issue: in `lava+ravine`, close up and from the side, lava inside the ravine can show as tall bright spikes.

## 3. Any word becomes a card

### With the server and a key

- [ ] `uv run deck` prints a line beginning `[words] new words are read by Gemini (gemini-3.5-flash-lite)` and naming the keys file. It must not print the key.
- [ ] Press **Tab**, type `castle` in **Add any word**, press Enter. Expected: a status line "Reading CASTLE…", then within about 2 to 6 seconds the card joins the tray and lands on the table.
- [ ] Try an object (`lighthouse`), a place (`swamp`), a mood (`jazz`), a phrase (`haunted house`) and another script (`火山`). Note how long each takes and whether a person would connect the result to the word.
- [ ] The same word a second time is instant ("made before").
- [ ] **While a word is being read, keep typing.** Expected: nothing else happens. Before: the letters went to the page, so X cleared every card and F went full screen.
- [ ] Hold **W** (camera moves), click into the word box, release W. Expected: the camera stops.
- [ ] In Combinations (**V**), **Add a word** works the same, tiles show the new card alone and mixed, opening a tile shows how the word was read.
- [ ] A boat word (`pirate ship`) beside WATER×3 floats on the water; with no water it sits on land.
- [ ] An object word beside MOUNTAIN (`dragon+mountain`): the object stands on the slope, not buried in it.
- [ ] A land object beside a swamp or lake stands on dry ground, not in the water.
- [ ] Put four or five word cards with objects down and drag another card. Expected: the frame rate does not collapse. Before: placing objects took up to 400 ms a frame.

### Without the server, or without a key

- [ ] Stop `uv run deck` and type a new word. Expected: at once, a card with a dashed border ("a guess"), an abstract shape coloured by the sound of the word, and the reason the model was not asked.
- [ ] `kiki` and `bouba` look clearly different (spiky and hot against round and cool).
- [ ] With the server back, **Try again** on a guess replaces it with the model's card.

### When Gemini misbehaves

- [ ] Put a wrong key in the keys file and restart. Expected: typing a word gives a guess, and the status says the key was refused.
- [ ] Type ten new words quickly. Expected: some may say "rate limited" (the free tier is small, and repeated asks count); none hangs for 20 seconds.

### Known gaps here

- **Remove** takes a card out of the page, but a card the server stored comes back on reload.
- With the model unreachable, a word one or two letters from a built-in word becomes that card: `fountain` gives MOUNTAIN, `raim` gives RAIN.
- If a word is read again while the Combinations view is closed, its tiles can show the old card until the view is refreshed.
- The camera still shows "?" for an unknown handwritten word: words are typed, not written, for now.

## 4. Where this branch meets main

- [ ] **Wind and lava together.** `mountain+lava+wind~45+rain`: wind streaks, slanted rain and lava all draw correctly, and the lava is not blown about or coloured like wind. (Both were written to use the same texture channels; wind was moved to its own.)
- [ ] **WIND bends everything it should:** chimney smoke, rain, clouds, people, boats, water ripples; wind beside ICE makes a blizzard; wind beside FOREST and RAIN (or LAKE, or RIVER) grows a line of trees downwind.
- [ ] **CIVILIZATION** alone is a village; a card reading VILLAGE, TOWN, CITY, PEOPLE or SETTLEMENT is the same card.
- [ ] **Two CIVILIZATION cards next to each other** are one town with a church, standing between them; **three** (in a row or a huddle) are one city with a castle. Apart, they are separate villages. **Not yet checked with real cards:** that scraps laid side by side on the sheet are close enough to count (within about a quarter of the sheet's width, centre to centre).
- [ ] **Villages look like main's:** cottages with windows and chimneys, each on its own plot; fewer people and sheep than before; five-wisp smoke from about two houses in five.
- [ ] **Merchants** travel between two settlements (not between the cards that make up one town or city).
- [ ] **Sound** plays and **M** mutes it.
- [ ] A word card made before today that used the old `people` field (for example CASTLE or CIRCUS, if stored) still grows a village.
- [ ] The card tray shows five cards to a row, word cards after the built-in ones, guesses with dashed borders.
- [ ] **With the phone camera** (nothing here has been tested with a real camera on this branch): cards are read, WIND's arrow sets its direction, and the play area stays fixed when a hand reaches in.

## 5. Not in this branch

- `origin/guff` (nuke, tsunami, tornado) is not merged. It conflicts in 14 files and its chimney-smoke shader has a bug that stops it compiling.
- The profiler's measured speed-ups for worlds with a volcano (caching the cone, sharing one drainage pass between water and lava) are not applied. Dragging a volcano or mountain with lava on the table costs about 8 to 11 ms a frame for the rules alone on a fast laptop.
- Nothing has been pushed.

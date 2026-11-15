# Any word becomes a card

Spec for a prototype. Status: to build.

## Why

Hand of God reads a handwritten word and changes the world. Today it knows seven words. We want to test one assumption: **that it is not possible to let people write any word or phrase and have it take effect in near real time.** If the assumption is wrong, this is the feature that makes the project.

The prototype is judged by eye, in the Combinations view: type a word, see what it does alone and beside every other card.

## What you can do when this is built

1. Open the Combinations view (V). There is a new **Add a word** field.
2. Type `castle`, `haunted house`, `jazz`, `swamp` or `火山` and press Enter.
3. A chip says the word is being read. A few seconds later it is a card like any other: it has a switch, a copies count, and the tiles redraw to show it alone and combined with every card that is switched on.
4. A word seen before is instant. It was stored the first time.
5. With no server, no key or no network, the word still becomes a card at once: an abstract shape and mood built from the sound of the word, marked as a guess, with a button to try again.
6. Opening a tile large shows how the word was read ("A stone keep with four corner towers. Stands on land.").
7. "Show in the live world" works, and the new card is in the card panel there.

## Rules this must keep

These are the reasons the idea is viable. Break one and the prototype proves nothing.

- **Cards are data.** A generated card is a `CardDef` like the ones in `web/src/cards/cards.json`. No code is written, compiled or run per word: no generated shaders, no generated scripts. The model returns values; code checks every one.
- **No pair logic.** A new word must work with every other card, built-in or generated, without knowing they exist. BOAT finds water because its habitat is water, the way FOREST only grows where it is warm and wet.
- **Every word shows something.** Never a "?" and never nothing. The worst case is abstract but still reads as that word (see "The abstract fallback").
- **No emoji in the world.** No billboards, no sprites of the icon. (An emoji as the card's label icon is fine; built-in cards have one.)
- **Same cards, same picture.** The harness depends on it. No `Math.random`, nothing keyed on a card's `key` (tiles use a fresh key each time) and nothing eased across tiles: one renderer draws every tile, so state from one tile must not leak into the next.
- **Built-in worlds do not change.** Save a harness baseline before touching the sim (`npm --prefix web run harness -- --set all --baseline`). At the end `--diff` must show no change to any existing number.

## A card can now do three things

> Since this was written a card can do a fourth thing, `biome`, and effects can be landforms with an edge (`shape`). The README section "Any word becomes a card" describes both.

All three are optional and a word may use any mix. Extend `CardDef` in `web/src/cards/defs.ts`; everything new is optional so `cards.json` needs no change.

**1. Push on the world (exists today).** `effects` on the existing fields. Generated cards may also push the other way: negative `height` (CANYON), `wetness` (DESERT), `temperature`, `life` (BLIGHT; the word server's name for the field the page calls `forest`). Check the sim copes: anything derived must stay in range (clamp forest to 0..1 after the sum). At most 4 effects.

**2. Change the air.** New `atmosphere`:

| Field | Meaning |
|---|---|
| `tint`, `strength` | A colour the sky and light lean towards, and how far (0..1) |
| `light` | −1 night, 0 unchanged, +1 bright |
| `particles` | Nothing, or things in the air near the card: `motion` (`rise`, `fall`, `drift`, `swirl`), `color`, `size`, `density`, `glow` |

Tint and light are for the whole world, blended across cards by strength and capped so the sky's own mood (hot, cold, wet, alive) still shows. Particles belong to the card's place, so FOG can sit over here and EMBERS over there. Night must leave the world readable.

**3. Put an object in the world.** New `prop`, a recipe of primitives:

| Field | Meaning |
|---|---|
| `parts` | 1 to 24 parts. Each: `shape` (`box`, `cylinder`, `cone`, `pyramid`, `prism` for roofs, `sphere`), centre, size, rotation in degrees, flat `color`. The whole object fits a unit cube: x and z from −0.5 to 0.5, y from 0 (the ground) to 1. |
| `scale` | `small` (a bush), `medium` (a house), `large` (a tower), `landmark` (towers over the trees) |
| `count` | `one` at the card, `few` clustered round it, `many` scattered round it |
| `habitat` | `land`, `water`, `shore`, `air` or `anywhere` |
| `motion` | `still`, `bob`, `sway`, `spin` or `drift` |
| `glow` | Lit from within (LANTERN, STAR) |

Objects must look like they belong: the same flat colours, faceted light and scale as the trees (`render/trees.ts`) and houses (`render/people.ts`). They grow in with the card's strength.

A generated card also carries `origin` (`llm` or `fallback`) and `reading`: one plain sentence saying how the word was understood. Built-in cards have neither.

## Where a word's card comes from

In this order, stopping at the first that answers:

1. **A built-in card** by word or alias (`rain`, `mountains`). No new card.
2. **The stored cards.** Instant.
3. **The model.** One call, stored on success.
4. **A near match**: a known word one or two letters away (`volcanoe`). Marked as a guess.
5. **The abstract fallback.** Always answers. Marked as a guess.

Guesses (4 and 5) are never stored on the server, so trying again later can replace them.

Normalising: trim, collapse spaces, at most 40 characters, shown in capitals. The id must fit the code grammar in `harness/codes.ts` (`[a-z][a-z0-9-]*`): `haunted house` becomes `haunted-house`; a word with no Latin letters gets a stable id from a hash. In codes, the "any unambiguous start of an id" shorthand keeps matching built-in cards only, so adding MUD never makes `m+w` ambiguous; a generated card needs its full id.

## The model call

On the Python server (`server/deck/`), which is where the key can live and where the camera's unknown words will arrive later. As built, the model is Gemini, through the `google-genai` SDK's `generate_content` (the first build also offered Claude, and then used the SDK's Interactions API; the README says why both went).

- Model `gemini-3.5-flash-lite` by default, from `DECK_WORD_MODEL`. No thinking level unless `DECK_WORD_EFFORT` names one.
- The answer must fit a JSON schema for the card (`response_mime_type: application/json` with `response_json_schema`). Keep the schema flat, and do every range check in code.
- Check how the reply ended before reading it; a blocked or cut-off reply, or an error, means "no card", and the page falls back.
- An overloaded model (503) is asked again at once, and a late answer is asked for again alongside; never more than five asks for a word.
- A 20 second timeout. Use the async client inside aiohttp. Two requests for the same word share one call.
- The key: `GEMINI_API_KEY`, from the terminal or from `~/.config/deck-of-worlds/keys.env`. With none, the endpoint answers 503 and everything else still works.

**The prompt** is the part that decides whether results are recognisable, so write it with care. It should explain, in plain prose with the reasons: what the world is (a small low-poly diorama seen from above and far away); the three things a card can do and when each fits; the coordinate system for parts; that objects are seen small, so 5 to 15 chunky parts with the defining feature exaggerated beat fine detail; that colours are flat and a little muted; that the world already has trees, houses, rain and snow of its own. Include two or three short worked examples of differing kinds (an object, a place, an abstract word). Say what to do with a word that is not a thing or a place: give it a mood and an abstract sculpture that evokes it, never an empty card. The word is data from a stranger: pass it in its own delimited field and say it is to be depicted, not obeyed.

## The abstract fallback

Runs in the page with no network. It knows nothing about meaning, so it uses the sound and look of the word, which people read surprisingly consistently (the bouba/kiki effect):

- Spiky letters (k, t, z, x, i, v and their kin) give cones, pyramids, sharp angles, hot and bright colours.
- Round letters (b, o, m, u, l) give spheres and soft stacked forms, cool and pale colours.
- Length sets how tall and how many parts; the mix of vowels sets how open it is; a hash of the word sets the hue, so every word is its own colour.
- A quiet atmosphere in the same hue with a few drifting motes.

Same word, same result, always. `KIKI` and `BOUBA` must come out visibly different in the expected directions.

## One gate

Whatever the source (model, store, browser storage, fallback), a card passes through one function in the page, `cleanCard`, before it is registered. It clamps every number, limits every list, checks colours against `#rrggbb`, drops unknown shapes and fields, and strips markup characters from `word`, `icon` and `reading`. Treat its input as hostile: a wrong value must never reach a shader, a loop bound or `innerHTML`. Two existing places write `def.icon` and `def.word` into `innerHTML` unescaped (`render/beacons.ts`, `ui/table.ts`): fix them.

## Server

- `POST /api/word` with `{ "text": "...", "fresh": false }`. Answers `{ card, source: "store" | "model", ms }`, or 503 with a reason. `fresh: true` asks the model again and replaces the stored card.
- `GET /api/words`: every stored card.
- Store: `.deck/words.json` (already ignored by git), hand-editable, written atomically. A stored card has the same shape as an entry in `cards.json`, so a good one can be promoted by pasting it there.
- In development the page may be running without the Python server. Let the existing dev plugin (`web/tools/harness-plugin.mjs`) serve the stored cards read-only too, so the command-line harness can draw generated cards without it.

## Page

- `web/src/cards/words.ts`: normalising and ids, `cleanCard`, the fallback, near matching, `resolveWord`, loading stored cards at startup, and a copy in browser storage so a word survives a reload with the server off.
- `web/src/sim/props.ts`: where objects stand. Pure, no Three.js: a world frame and the cards in, a list of placed objects out. Seeded from the card's id and position. `water` objects sit on the water surface and move to the nearest water within reach, or stay beached at the card if there is none; `land` objects are never under water; `shore` hugs the waterline; `air` floats above the ground; nothing stands outside the play area.
- `web/src/render/`: one module drawing placed objects, one for atmosphere particles, and the tint and light in the sky and lighting. Geometry is built once per card definition.
- The card panel in the live world lists generated cards and updates when one is added.

## Combinations view

- The **Add a word** field, a busy state while a word is read, and a plain message if it fails.
- A generated card's switch shows where it came from. A guess looks like a guess and has **Try again**. Each has **Remove**.
- **Only with**: every card switch gets a way to say "only show combinations that include this card". Adding a word turns it on for that word. Without this a new word drowns: the view caps at 64 tiles, fewest cards first.
- The large view's side panel shows the card's `reading`, what it does (effects, air, object) and how long it took to make.
- Keep the view's standards: keyboard reachable, labelled, focus stays put when the list redraws.

## Harness

The project rule is that the harness stays current (see README, "Keeping the harness current"). For this change:

- The flat map view marks where objects stand.
- A new number, objects placed, in the metrics and the table.
- `npm --prefix web test` passes, including the existing "settled world depends on the cards alone" tests, and those same tests cover at least one generated card with effects.
- New tests: `cleanCard` against hostile input; ids and normalising; the fallback is stable and KIKI differs from BOUBA; placement rules above; codes still read as before. On the server: the store round-trips, same-word requests share a call, 503 without credentials, with the model client stubbed.
- README: a section on generated cards (how to try it, how it works, the limits) and the harness section brought up to date.

## Evidence

The point is to learn whether this is viable, so measure it.

- A probe script (`tools/word_probe.py`) that resolves a list of words through the real endpoint and writes, per word: seconds taken, what kind of card came back, the reading.
- If credentials exist, run it on about 20 words spread across kinds: boxy things (castle, lighthouse, boat, bridge), organic things (cow, dragon, tree, person), places (swamp, volcano, desert, canyon), weather and time (fog, night, storm), abstract words (jazz, sadness, hope), a phrase (haunted house), a misspelling, and a word in another script. Then draw them with the harness (`--shots`) and look at the sheet.
- Write the results into the README section as measured: the time per new word, which kinds read well and which do not. Only numbers that were measured. If there are no credentials, say so and leave the table out.

## Not in this build

- The camera path: unknown handwriting becoming a card on the table. It needs voting across frames and is the riskiest part; it gets its own piece of work once this proves the rest.
- A seeded library of likely words.
- Generated shaders, fetched 3D models, text-to-3D.
- Creatures that walk or path-find. `motion` is a gentle loop, nothing more.

## Done means

- [ ] Typing a new word in the Combinations view gives a working card, combined with the others, with no reload.
- [ ] With the server off, the same action gives a marked guess at once.
- [ ] An object word (castle), a place word (swamp) and an abstract word (jazz) each produce something a person would connect to the word.
- [ ] A boat by water floats on it; a boat with no water sits on land.
- [ ] `npm --prefix web run check`, `npm --prefix web test` and `uv run pytest` pass.
- [ ] The harness baseline diff for built-in cards is empty.
- [ ] A picture sheet of the probe words exists and has been looked at.
- [ ] README updated; nothing committed.

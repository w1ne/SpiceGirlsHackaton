# Hell's Kitchen mode — real Gordon Ramsay roasts while you cook

## What

A switchable mode (🔥 toggle in the app header) that plays **real Gordon
Ramsay audio clips** — his actual voice, his actual phrases — at random
moments while you cook, plus a quick jab right after each dispense.

## Why

Cooking with the dispenser should be fun. A synthetic "fiery chef" persona
already exists (`personas.js`), but nothing beats the real "IT'S RAW!".

## Components

### 1. Clip pool — fetched, never in the public repo

- `tools/fetch-ramsay.sh` downloads ~20 iconic clips into
  `app/public/ramsay/` (**gitignored**). The normal `npm run apk` build then
  packs them into the APK like any static asset.
- Source order: (1) the **private** `w1ne/SpiceDispenser-assets` GitHub repo
  (durable, needs `gh` auth), (2) public soundboard direct-MP3 URLs as
  fallback. The script verifies each download is a real audio file
  (HTTP 200, nonzero, `file` says audio) and reports a summary.
- The clips are copyrighted TV audio: private repo + gitignored local folder
  keeps them out of public distribution; the APK is shared privately.
- `app/src/ramsayClips.js` (**committed**) is the manifest:
  `[{ file: "its-raw.mp3", phrase: "IT'S RAW!" }, …]` — the app knows the
  pool and shows the phrase as a chat bubble when a clip plays.

### 2. Roast engine — `app/src/roast.js`

Same single-owner style as `voiceGate`. `createRoaster({ playClip, clips,
isSuppressed, onRoast, randomDelayMs })`:

- `start()` / `stop()` — the switch. While on, schedules the next roast at a
  random **2–5 min** interval; each roast picks a random clip (no immediate
  repeat), plays it, bubbles `🔥 "PHRASE"`, reschedules.
- `dispenseJab()` — called after a dispense completes: plays one clip ~1 s
  later. Throttled to one jab per dispense batch and not within 30 s of the
  previous roast.
- **Suppression:** if `isSuppressed()` (a live realtime voice session —
  `voiceGate.active`) the roast is skipped and rescheduled; the open mic
  must never hear Ramsay, or the AI argues with him and acts on his words.
  Deliberate trade-off: no roasts during voice conversations.
- Playback through one `<audio>` element; a new roast never overlaps a
  playing clip (skip + reschedule) — the one-voice rule applies to Gordon
  too.

### 3. UI + persistence

- 🔥 button in the header row next to the persona chip. Lit (CSS class)
  when on. `LS.hellsKitchen` ("1"/"0") persists across launches; the
  roaster starts on boot if enabled.
- Missing clips (fresh clone, script not run): toggling on bubbles
  "Run tools/fetch-ramsay.sh to summon Gordon" and stays off.

### 4. Error handling

- Clip 404/decode error → skip clip, drop it from the session pool,
  reschedule. Mode never crashes the app.
- Audio play() rejection (autoplay policy) → first roast is armed by the
  toggle tap itself (a user gesture), so the WebView allows playback.

## Testing

- Vitest + fake timers for the scheduler: random-window bounds, suppression
  skip+reschedule, dispense-jab throttle, no-repeat clip pick, stop()
  cancels timers.
- Device test: toggle on → hear a real clip; dispense → jab; start a voice
  session → silence from Gordon; stop session → roasts resume.

## Out of scope

- Voice-cloned Ramsay in the realtime session (impersonation; not done).
- Reacting to *what* you're cooking (clips are random, not contextual).

# Hell's Kitchen Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A switchable 🔥 mode that plays real Gordon Ramsay audio clips at random 2–5 min intervals while cooking, plus a jab after each dispense — silent while a realtime voice session is live.

**Architecture:** Pure scheduler module (`roast.js`, fully unit-testable with injected timers/rng) + committed clip manifest (`ramsayClips.js`) + gitignored clip pool fetched by `tools/fetch-ramsay.sh` (private repo `w1ne/SpiceDispenser-assets` first, MyInstants fallback) + thin wiring in `main.js` (toggle button, `<audio>` playback, dispense hook, `voiceGate.active` suppression).

**Tech Stack:** Vanilla JS (Vite + Capacitor WebView), vitest fake timers, bash + curl + gh.

---

### Task 1: Roast scheduler engine (TDD)

**Files:**
- Create: `app/src/roast.js`
- Test: `app/src/roast.test.js`

- [ ] **Step 1: Write the failing tests**

`app/src/roast.test.js`:
```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoaster } from "./roast.js";

const CLIPS = [
  { file: "a.mp3", phrase: "A" },
  { file: "b.mp3", phrase: "B" },
  { file: "c.mp3", phrase: "C" },
];

function makeRoaster(overrides = {}) {
  const calls = { played: [], roasted: [] };
  const roaster = createRoaster({
    clips: CLIPS,
    playClip: vi.fn(async (c) => { calls.played.push(c.file); }),
    isSuppressed: () => false,
    onRoast: (c) => calls.roasted.push(c.phrase),
    minDelayMs: 120_000,
    maxDelayMs: 300_000,
    jabDelayMs: 1_000,
    jabCooldownMs: 30_000,
    rng: () => 0.5, // deterministic: delay = min + 0.5*(max-min) = 210s
    ...overrides,
  });
  return { roaster, calls };
}

describe("roaster — random Ramsay while cooking", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("plays nothing until started, then roasts inside the 2–5 min window", async () => {
    const { roaster, calls } = makeRoaster();
    await vi.advanceTimersByTimeAsync(400_000);
    expect(calls.played).toHaveLength(0);
    roaster.start();
    await vi.advanceTimersByTimeAsync(209_000);
    expect(calls.played).toHaveLength(0); // not before the scheduled moment
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.played).toHaveLength(1); // fired at min + rng*(max-min)
    expect(calls.roasted).toHaveLength(1);
  });

  it("reschedules itself after each roast", async () => {
    const { roaster, calls } = makeRoaster();
    roaster.start();
    await vi.advanceTimersByTimeAsync(211_000);
    await vi.advanceTimersByTimeAsync(211_000);
    expect(calls.played).toHaveLength(2);
  });

  it("never plays the same clip twice in a row", async () => {
    // rng fixed at 0 → would always pick index 0 without the no-repeat guard
    const { roaster, calls } = makeRoaster({ rng: () => 0 });
    roaster.start();
    await vi.advanceTimersByTimeAsync(121_000);
    await vi.advanceTimersByTimeAsync(121_000);
    await vi.advanceTimersByTimeAsync(121_000);
    expect(calls.played).toHaveLength(3);
    expect(calls.played[0]).not.toBe(calls.played[1]);
    expect(calls.played[1]).not.toBe(calls.played[2]);
  });

  it("skips and reschedules while suppressed (live voice session)", async () => {
    let suppressed = true;
    const { roaster, calls } = makeRoaster({ isSuppressed: () => suppressed });
    roaster.start();
    await vi.advanceTimersByTimeAsync(211_000);
    expect(calls.played).toHaveLength(0); // Gordon stays quiet during the call
    suppressed = false;
    await vi.advanceTimersByTimeAsync(211_000);
    expect(calls.played).toHaveLength(1); // resumes after the session ends
  });

  it("stop() cancels the pending roast", async () => {
    const { roaster, calls } = makeRoaster();
    roaster.start();
    roaster.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls.played).toHaveLength(0);
    expect(roaster.active).toBe(false);
  });

  it("dispenseJab() roasts ~1s after a dispense", async () => {
    const { roaster, calls } = makeRoaster();
    roaster.start();
    roaster.dispenseJab();
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.played).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.played).toHaveLength(1);
  });

  it("dispenseJab() is a no-op when mode is off, when suppressed, and inside the cooldown", async () => {
    let suppressed = false;
    const { roaster, calls } = makeRoaster({ isSuppressed: () => suppressed });
    roaster.dispenseJab(); // not started
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.played).toHaveLength(0);

    roaster.start();
    suppressed = true;
    roaster.dispenseJab(); // suppressed
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.played).toHaveLength(0);

    suppressed = false;
    roaster.dispenseJab(); // fires
    await vi.advanceTimersByTimeAsync(1_100);
    expect(calls.played).toHaveLength(1);
    roaster.dispenseJab(); // inside 30s cooldown → no-op
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.played).toHaveLength(1);
  });

  it("a clip that fails to play is dropped from the pool and the mode keeps going", async () => {
    const playClip = vi.fn(async (c) => { if (c.file === "b.mp3") throw new Error("404"); });
    const { roaster, calls } = makeRoaster({ playClip, rng: () => 0.4 }); // 0.4*3 → index 1 = b.mp3 first
    roaster.start();
    await vi.advanceTimersByTimeAsync(200_000);
    await vi.advanceTimersByTimeAsync(200_000);
    await vi.advanceTimersByTimeAsync(200_000);
    // b.mp3 failed once, was dropped, later roasts never pick it again
    const after = playClip.mock.calls.map((c) => c[0].file).slice(1);
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toContain("b.mp3");
    expect(calls.roasted.length).toBe(after.length); // failed play didn't bubble a roast
  });

  it("never overlaps clips — a roast due while one is playing is skipped and rescheduled", async () => {
    let resolvePlay;
    const playClip = vi.fn(() => new Promise((r) => { resolvePlay = r; }));
    const { roaster } = makeRoaster({ playClip, minDelayMs: 1_000, maxDelayMs: 1_000 });
    roaster.start();
    await vi.advanceTimersByTimeAsync(1_001); // roast 1 starts, never resolves yet
    await vi.advanceTimersByTimeAsync(1_001); // roast 2 due while 1 playing → skipped
    expect(playClip).toHaveBeenCalledTimes(1);
    resolvePlay();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(playClip).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run src/roast.test.js`
Expected: FAIL — `Failed to load url ./roast.js`

- [ ] **Step 3: Implement `app/src/roast.js`**

```js
// Hell's Kitchen mode scheduler. Plays a random real-Ramsay clip every
// minDelay..maxDelay while active, plus a jab shortly after a dispense.
// Pure logic — playback, suppression and UI are injected — so the whole
// thing unit-tests with fake timers.
//
// Invariants:
//  • silent while isSuppressed() (a live voice session: the open mic must
//    never hear Gordon, or the AI argues with him and acts on his words)
//  • one clip at a time, never the same clip twice in a row
//  • a clip that fails to play is dropped from the pool for this session
export function createRoaster({
  clips,
  playClip,                 // async (clip) => resolves when audio finished
  isSuppressed = () => false,
  onRoast = () => {},       // (clip) => surface the phrase in the UI
  minDelayMs = 120_000,     // 2 min
  maxDelayMs = 300_000,     // 5 min
  jabDelayMs = 1_000,       // dispense → beat → roast
  jabCooldownMs = 30_000,   // don't machine-gun jabs across batches
  rng = Math.random,
} = {}) {
  let pool = [...(clips || [])];
  let active = false;
  let timer = null, jabTimer = null;
  let playing = false;
  let lastFile = null;
  let lastRoastAt = -Infinity;
  let clock = 0; // advanced via timers only — works under fake timers

  const tick = (ms) => { clock += ms; };

  function schedule() {
    clearTimeout(timer);
    const delay = minDelayMs + rng() * (maxDelayMs - minDelayMs);
    timer = setTimeout(() => { tick(delay); fire().then(schedule); }, delay);
  }

  function pick() {
    const candidates = pool.length > 1 ? pool.filter((c) => c.file !== lastFile) : pool;
    return candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
  }

  async function fire() {
    if (!active || playing || isSuppressed() || !pool.length) return;
    const clip = pick();
    if (!clip) return;
    playing = true;
    try {
      await playClip(clip);
      lastFile = clip.file;
      lastRoastAt = clock;
      onRoast(clip);
    } catch {
      pool = pool.filter((c) => c.file !== clip.file); // bad clip → out of the pool
    } finally {
      playing = false;
    }
  }

  return {
    get active() { return active; },
    start() {
      if (active) return;
      active = true;
      schedule();
    },
    stop() {
      active = false;
      clearTimeout(timer); timer = null;
      clearTimeout(jabTimer); jabTimer = null;
    },
    dispenseJab() {
      if (!active || playing || isSuppressed()) return;
      if (clock - lastRoastAt < jabCooldownMs) return;
      clearTimeout(jabTimer);
      jabTimer = setTimeout(() => { tick(jabDelayMs); fire(); }, jabDelayMs);
    },
  };
}
```

Note: `clock` advances inside timer callbacks instead of `Date.now()` so the
cooldown logic is exact under vitest fake timers (and real time in prod, since
real timers fire after real delays).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npx vitest run src/roast.test.js`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add app/src/roast.js app/src/roast.test.js
git commit -m "app: roast scheduler for Hell's Kitchen mode"
```

### Task 2: Clip manifest + fetch script

**Files:**
- Create: `app/src/ramsayClips.js`
- Create: `tools/fetch-ramsay.sh` (executable)
- Modify: `.gitignore` (repo root)

- [ ] **Step 1: Write the manifest** — `app/src/ramsayClips.js`:

```js
// Real Gordon Ramsay clip pool for Hell's Kitchen mode. The MP3s are NOT in
// this repo (copyrighted TV audio) — run tools/fetch-ramsay.sh to download
// them into app/public/ramsay/ (gitignored); the build then packs them into
// the APK like any static asset. This manifest is the app's source of truth
// for what exists and what to print in the chat bubble when a clip plays.
export const RAMSAY_CLIPS = [
  { file: "wheres-the-lamb-sauce.mp3", phrase: "WHERE'S THE LAMB SAUCE?!" },
  { file: "rawwww_ramsay.mp3", phrase: "It's RAAAW!" },
  { file: "gordon-you-donkey.mp3", phrase: "You DONKEY!" },
  { file: "gordon-ramsey-what-are-you-an-idiot-sandwich.mp3", phrase: "What are you? An idiot sandwich." },
  { file: "idiot-sandwich.mp3", phrase: "An idiot sandwich." },
  { file: "gordon-burnt-pan.mp3", phrase: "This pan is BURNT!" },
  { file: "gordon-teamwork.mp3", phrase: "TEAMWORK!" },
  { file: "rubber-rubber-rubber-1.mp3", phrase: "Rubber! Rubber! Rubber!" },
  { file: "its-black.mp3", phrase: "It's BLACK!" },
  { file: "gordon-nonstick-pan.mp3", phrase: "Non-stick pan… and it's STUCK." },
  { file: "how-much-is-in-the-bin.mp3", phrase: "How much is in the BIN?!" },
  { file: "rotten_ramsay.mp3", phrase: "It's ROTTEN!" },
  { file: "gordon-burnt-duck.mp3", phrase: "You've burnt the duck…" },
  { file: "youre-making-me-mad.mp3", phrase: "You're making me MAD!" },
  { file: "gordon-ramsay-you-fucing-dounut.mp3", phrase: "You doughnut!" },
  { file: "how-much-capellini.mp3", phrase: "How much capellini?!" },
  { file: "look-look-wtf-is-this.mp3", phrase: "Look! LOOK! What is THIS?!" },
];
```

- [ ] **Step 2: Write `tools/fetch-ramsay.sh`**

```bash
#!/usr/bin/env bash
# Download the real-Ramsay clip pool into app/public/ramsay/ (gitignored).
# Source 1: private repo w1ne/SpiceDispenser-assets (durable; needs gh auth).
# Source 2: the original public soundboard URLs (fallback).
# The clips are copyrighted TV audio — they stay out of the public repo.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=app/public/ramsay
mkdir -p "$DEST"

CLIPS=(
  wheres-the-lamb-sauce.mp3 rawwww_ramsay.mp3 gordon-you-donkey.mp3
  gordon-ramsey-what-are-you-an-idiot-sandwich.mp3 idiot-sandwich.mp3
  gordon-burnt-pan.mp3 gordon-teamwork.mp3 rubber-rubber-rubber-1.mp3
  its-black.mp3 gordon-nonstick-pan.mp3 how-much-is-in-the-bin.mp3
  rotten_ramsay.mp3 gordon-burnt-duck.mp3 youre-making-me-mad.mp3
  gordon-ramsay-you-fucing-dounut.mp3 how-much-capellini.mp3
  look-look-wtf-is-this.mp3
)

ok=0; fail=0
for f in "${CLIPS[@]}"; do
  out="$DEST/$f"
  [ -s "$out" ] && { ok=$((ok+1)); continue; }
  if gh api "repos/w1ne/SpiceDispenser-assets/contents/ramsay/$f" \
       -H "Accept: application/vnd.github.raw" > "$out" 2>/dev/null && [ -s "$out" ]; then
    ok=$((ok+1)); continue
  fi
  if curl -fsSL "https://www.myinstants.com/media/sounds/$f" -o "$out" && [ -s "$out" ]; then
    ok=$((ok+1)); continue
  fi
  rm -f "$out"; fail=$((fail+1)); echo "MISS  $f"
done
echo "ramsay clips: $ok ok, $fail missing → $DEST"
[ "$fail" -eq 0 ]
```

- [ ] **Step 3: Gitignore the pool** — append to repo-root `.gitignore`:

```
# real-Ramsay clip pool (copyrighted audio; fetched by tools/fetch-ramsay.sh)
app/public/ramsay/
```

- [ ] **Step 4: Run and verify**

Run: `chmod +x tools/fetch-ramsay.sh && tools/fetch-ramsay.sh`
Expected: `ramsay clips: 17 ok, 0 missing` and `git status` shows NO new
untracked files under `app/`.

- [ ] **Step 5: Commit**

```bash
git add app/src/ramsayClips.js tools/fetch-ramsay.sh .gitignore
git commit -m "app: real-Ramsay clip manifest + private-first fetch script"
```

### Task 3: Wire into the app (toggle, playback, dispense jab)

**Files:**
- Modify: `app/index.html:12-18` (header buttons)
- Modify: `app/src/style.css` (lit toggle state)
- Modify: `app/src/main.js` (LS flag, roaster wiring, dispense hook, boot)

- [ ] **Step 1: Header button** — in `app/index.html`, after the `personaBtn` line:

```html
      <button id="roastBtn" class="icon" title="Hell's Kitchen mode — real Ramsay roasts">🔥</button>
```

- [ ] **Step 2: Lit state CSS** — append to `app/src/style.css`:

```css
/* Hell's Kitchen toggle: dim ember when off, lit when Gordon is on duty */
#roastBtn { opacity: 0.45; }
#roastBtn.on { opacity: 1; text-shadow: 0 0 12px #ff5a1f; }
```

- [ ] **Step 3: Wire `app/src/main.js`**

Imports (top of file, with the other imports):
```js
import { createRoaster } from "./roast.js";
import { RAMSAY_CLIPS } from "./ramsayClips.js";
```

LS flag (inside the `LS` object):
```js
  // Hell's Kitchen mode: random real-Ramsay roasts while cooking.
  get hellsKitchen() { return localStorage.getItem("hells_kitchen") === "1"; },
  set hellsKitchen(v) { localStorage.setItem("hells_kitchen", v ? "1" : "0"); },
```

Roaster section (after the realtime-voice section, so `voiceGate` exists):
```js
// ---------- Hell's Kitchen mode (real Ramsay roasts) ----------
const roastAudio = new Audio();
function playRamsayClip(clip) {
  return new Promise((resolve, reject) => {
    roastAudio.src = `ramsay/${clip.file}`;
    roastAudio.onended = resolve;
    roastAudio.onerror = () => reject(new Error("clip failed: " + clip.file));
    roastAudio.play().catch(reject);
  });
}
const roaster = createRoaster({
  clips: RAMSAY_CLIPS,
  playClip: playRamsayClip,
  isSuppressed: () => voiceGate.active, // the AI must never hear Gordon
  onRoast: (clip) => bubble(`🔥 ${clip.phrase}`),
});
async function setHellsKitchen(on) {
  if (on) {
    // Fresh clone without the clip pool: explain instead of failing silently.
    const probe = await fetch(`ramsay/${RAMSAY_CLIPS[0].file}`, { method: "HEAD" }).catch(() => null);
    if (!probe || !probe.ok) {
      bubble("🔥 No Ramsay clips in this build — run tools/fetch-ramsay.sh and rebuild.");
      return;
    }
    roaster.start();
    bubble("🔥 Hell's Kitchen mode ON. Gordon is watching.");
  } else {
    roaster.stop();
    bubble("Hell's Kitchen mode off. Gordon has left the kitchen. 🚪");
  }
  LS.hellsKitchen = on;
  $("#roastBtn").classList.toggle("on", on);
}
$("#roastBtn").onclick = () => setHellsKitchen(!roaster.active);
```

Dispense hook — at the END of the real-dispense path in `dispense()` (after
the `for` loop over steps, before the function closes):
```js
  roaster.dispenseJab(); // Gordon comments on your seasoning
```

Boot — inside the `init()` IIFE, after `syncPersonaChip()`:
```js
  if (LS.hellsKitchen) setHellsKitchen(true);
```

- [ ] **Step 4: Run all tests + build**

Run: `cd app && npm test && npm run build`
Expected: all suites pass (38 = 29 existing + 9 roast), build succeeds, and
`ls dist/ramsay | wc -l` prints 17.

- [ ] **Step 5: Commit**

```bash
git add app/index.html app/src/style.css app/src/main.js
git commit -m "app: Hell's Kitchen mode — switchable real-Ramsay roasts"
```

### Task 4: Ship + verify on device

**Files:**
- Modify: `CHANGELOG.md` (add bullet under v1.1.1)

- [ ] **Step 1: Changelog bullet** (top of the v1.1.1 list):

```markdown
- **Hell's Kitchen mode.** 🔥 toggle in the header: the dispenser plays real
  Gordon Ramsay clips at random moments while you cook, plus a jab right
  after each dispense. Pauses automatically during voice conversations so
  the AI doesn't argue with Gordon. Clips aren't in the repo — run
  `tools/fetch-ramsay.sh` before building.
```

- [ ] **Step 2: Build + install**

Run: `cd app && npm run apk && cd .. && adb install -r SpiceGirls.apk`
Expected: `Success`.

- [ ] **Step 3: Device verification** (foreground-checked taps or hand to user)

- Tap 🔥 → bubble "Hell's Kitchen mode ON", button lit.
- Force a quick roast for the test: temporarily not needed — tap a spice
  tile instead: dispense runs → ~1 s later a real Ramsay clip plays and the
  phrase bubbles.
- Start a voice session → no roasts while live; stop → mode still on.
- Relaunch app → mode remembered (button lit).

- [ ] **Step 4: Commit + final**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog — Hell's Kitchen mode"
```

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
  let clock = 0; // advanced inside timer callbacks only — exact under fake timers

  const tick = (ms) => { clock += ms; };

  function schedule() {
    clearTimeout(timer);
    if (!active) return;
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

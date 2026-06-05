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

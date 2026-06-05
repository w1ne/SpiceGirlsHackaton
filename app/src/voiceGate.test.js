import { describe, it, expect, vi } from "vitest";
import { createVoiceGate } from "./voiceGate.js";

// A start that we can resolve/reject by hand — models the 2-5s realtime
// startup window (token mint + getUserMedia + SDP) where the old code raced.
function deferredStart() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { startFn: vi.fn(() => promise), resolve, reject };
}
const fakeSession = () => ({ stop: vi.fn() });

describe("voiceGate — one voice session, ever", () => {
  it("is active synchronously from the moment start() is called", () => {
    const gate = createVoiceGate();
    const d = deferredStart();
    gate.start(d.startFn);
    expect(gate.active).toBe(true); // a tap during startup must route to STOP
  });

  it("ignores a second start while the first is still starting (the double-tap that made two voices)", async () => {
    const gate = createVoiceGate();
    const d = deferredStart();
    const first = gate.start(d.startFn);
    const second = gate.start(d.startFn);
    d.resolve(fakeSession());
    expect(await second).toBeNull();
    expect(await first).not.toBeNull();
    expect(d.startFn).toHaveBeenCalledTimes(1);
  });

  it("ignores a second start while one session is already live", async () => {
    const gate = createVoiceGate();
    const s = fakeSession();
    await gate.start(async () => s);
    const again = await gate.start(vi.fn());
    expect(again).toBeNull();
  });

  it("stop() during startup kills the session the moment it lands — no orphaned voice", async () => {
    const gate = createVoiceGate();
    const d = deferredStart();
    const started = gate.start(d.startFn);
    gate.stop(); // user tapped Stop while we were still connecting
    const s = fakeSession();
    d.resolve(s);
    expect(await started).toBeNull(); // caller must not treat it as live
    expect(s.stop).toHaveBeenCalledTimes(1); // the in-flight session was stopped, not orphaned
    expect(gate.active).toBe(false);
  });

  it("stop() stops the live session and frees the gate", async () => {
    const gate = createVoiceGate();
    const s = fakeSession();
    await gate.start(async () => s);
    gate.stop();
    expect(s.stop).toHaveBeenCalledTimes(1);
    expect(gate.active).toBe(false);
  });

  it("can start a fresh session after stop", async () => {
    const gate = createVoiceGate();
    await gate.start(async () => fakeSession());
    gate.stop();
    const s2 = fakeSession();
    expect(await gate.start(async () => s2)).toBe(s2);
    expect(gate.active).toBe(true);
  });

  it("a failed start rethrows and leaves the gate ready to try again", async () => {
    const gate = createVoiceGate();
    await expect(gate.start(async () => { throw new Error("sdp 500"); })).rejects.toThrow("sdp 500");
    expect(gate.active).toBe(false);
    const s = fakeSession();
    expect(await gate.start(async () => s)).toBe(s);
  });

  it("a start that fails AFTER stop() was tapped swallows the error (session never existed)", async () => {
    const gate = createVoiceGate();
    const d = deferredStart();
    const started = gate.start(d.startFn);
    gate.stop();
    d.reject(new Error("aborted"));
    expect(await started).toBeNull(); // no unhandled rejection, no stuck state
    expect(gate.active).toBe(false);
  });

  it("gen changes on stop — callbacks captured before a stop can detect they're stale", async () => {
    const gate = createVoiceGate();
    const before = gate.gen;
    gate.start(deferredStart().startFn);
    expect(gate.gen).toBe(before); // starting alone doesn't invalidate
    gate.stop();
    expect(gate.gen).not.toBe(before);
  });

  it("stop() with nothing running is a safe no-op", () => {
    const gate = createVoiceGate();
    expect(() => { gate.stop(); gate.stop(); }).not.toThrow();
    expect(gate.active).toBe(false);
  });
});

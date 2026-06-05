// Single-owner lifecycle for THE voice session. Exactly one session (realtime
// or classic) may be live or starting at any moment — this is what guarantees
// two voices can never talk at once.
//
// Why a gate and not just a flag: starting a realtime session takes seconds
// (token mint + getUserMedia + SDP roundtrip). A plain flag can't handle Stop
// being tapped INSIDE that window — the session would still land afterwards
// and keep talking with no handle left to stop it (the "two voices" bug). The
// generation counter makes stop() retroactive: a session that lands after a
// stop() is killed the moment it arrives.
export function createVoiceGate() {
  let gen = 0;          // bumped by stop(); an in-flight start compares on landing
  let starting = false; // single-flight: a tap can't start a 2nd session mid-startup
  let session = null;   // the one live session ({ stop() })

  return {
    // True from the first instant of start() — so the mic button routes the
    // very next tap to STOP, never to a second start.
    get active() { return starting || !!session; },

    // Capture before starting; compare later to ignore stale callbacks (e.g.
    // a killed-mid-startup session's progress logs overwriting the status bar).
    get gen() { return gen; },

    // startFn: async () => ({ stop() }). Returns the session if it went live,
    // or null if this start lost (duplicate tap, or stopped mid-startup).
    // Rethrows startFn failures unless stop() already happened.
    async start(startFn) {
      if (starting || session) return null;
      starting = true;
      const myGen = gen;
      let s;
      try { s = await startFn(); }
      catch (e) {
        starting = false;
        if (gen !== myGen) return null; // user already stopped — nothing to surface
        throw e;
      }
      starting = false;
      if (gen !== myGen) { try { s.stop(); } catch {} return null; } // stopped mid-startup
      session = s;
      return s;
    },

    stop() {
      gen++; // kills any start still in flight
      const s = session;
      session = null;
      if (s) { try { s.stop(); } catch {} }
    },
  };
}

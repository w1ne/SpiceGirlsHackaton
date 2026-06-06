import { describe, test, expect, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above the file, so anything they reference must
// be created in vi.hoisted (which is hoisted too). CONFIG is mutable so tests can
// tweak the creds; startSession captures what we hand the SDK.
const { CONFIG, startSession } = vi.hoisted(() => ({
  CONFIG: { ELEVEN_BASE: "https://api.elevenlabs.io", ELEVEN_AGENT_ID: "agent_x", ELEVEN_KEY: "xi-key" },
  startSession: vi.fn(),
}));
vi.mock("../config.js", () => ({ CONFIG }));
vi.mock("@elevenlabs/client", () => ({ Conversation: { startSession } }));
// Capacitor: pretend we're on web so the native audio-session call is a no-op.
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: () => ({ setInCall: vi.fn() }),
}));

import { startEleven } from "./eleven.js";

const okFetch = () => vi.fn(async (url, init) => {
  okFetch.lastUrl = url; okFetch.lastInit = init;
  return { ok: true, json: async () => ({ signed_url: "wss://convai/abc" }), text: async () => "" };
});

function base(over = {}) {
  return {
    instructions: "be a sassy spice master",
    toolNames: ["dispense", "set_compartments"],
    onToolCall: vi.fn(async () => ({ ok: true, dispensed: 1 })),
    onUserText: vi.fn(), onBotText: vi.fn(), log: vi.fn(), onIdle: vi.fn(),
    idleMs: 0,            // no timers in tests
    ...over,
  };
}

beforeEach(() => {
  CONFIG.ELEVEN_AGENT_ID = "agent_x"; CONFIG.ELEVEN_KEY = "xi-key";
  startSession.mockReset(); startSession.lastOpts = undefined;
  startSession.mockImplementation(async (opts) => { startSession.lastOpts = opts; return { endSession: vi.fn() }; });
  global.fetch = okFetch();
});

describe("startEleven", () => {
  test("refuses to start without a key + agent id", async () => {
    CONFIG.ELEVEN_KEY = "";
    await expect(startEleven(base())).rejects.toThrow(/Settings/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("mints a signed URL with the key, then opens the session with it", async () => {
    await startEleven(base());
    expect(okFetch.lastUrl).toContain("/v1/convai/conversation/get-signed-url?agent_id=agent_x");
    expect(okFetch.lastInit.headers["xi-api-key"]).toBe("xi-key");
    expect(startSession.lastOpts.signedUrl).toBe("wss://convai/abc");
  });

  test("pushes the live persona prompt as an override", async () => {
    await startEleven(base());
    expect(startSession.lastOpts.overrides.agent.prompt.prompt).toBe("be a sassy spice master");
  });

  test("routes a client-tool call to onToolCall and returns the result as a string", async () => {
    const args = base();
    await startEleven(args);
    const tool = startSession.lastOpts.clientTools.dispense;
    const out = await tool({ steps: [{ compartment: 1, dose_units: 1 }] });
    expect(args.onToolCall).toHaveBeenCalledWith("dispense", { steps: [{ compartment: 1, dose_units: 1 }] });
    expect(out).toBe('{"ok":true,"dispensed":1}');           // SDK requires a string result
  });

  test("declares exactly the requested tools", async () => {
    await startEleven(base());
    expect(Object.keys(startSession.lastOpts.clientTools).sort()).toEqual(["dispense", "set_compartments"]);
  });

  test("routes user vs agent transcripts to the right callback", async () => {
    const args = base();
    await startEleven(args);
    startSession.lastOpts.onMessage({ message: "add cumin", source: "user" });
    startSession.lastOpts.onMessage({ message: "coming up", source: "ai" });
    expect(args.onUserText).toHaveBeenCalledWith("add cumin");
    expect(args.onBotText).toHaveBeenCalledWith("coming up");
  });

  test("surfaces a signed-url failure instead of opening a session", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401, text: async () => "unauthorized" }));
    await expect(startEleven(base())).rejects.toThrow(/signed-url 401/);
    expect(startSession).not.toHaveBeenCalled();
  });
});

// ElevenLabs Conversational AI — speech-to-speech, wired to the SAME dispenser
// tool surface as the OpenAI Realtime path (realtime.js). Selectable in Settings
// as a third voice mode. The ElevenLabs SDK owns the mic, playback and
// turn-taking; we own the tool implementations, the persona prompt override, and
// the Android audio-session trick.
//
// Credentials live ONLY in the browser (Settings → localStorage), never baked
// into a build: the local xi-api-key mints a short-lived signed URL for the
// (private) agent, and the SDK connects to that. On device, Capacitor's native
// fetch bypasses CORS; in web dev the agent must allow the origin or be public.
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Conversation } from "@elevenlabs/client";
import { CONFIG } from "../config.js";

// Native audio-session control (Android) — same plugin realtime.js uses. Voice-
// call mode engages the platform hardware echo canceller so the bot doesn't hear
// itself through the open mic. No-op on web dev.
const AudioMode = registerPlugin("AudioMode");
async function setInCallAudio(on) {
  if (!Capacitor.isNativePlatform()) return;
  try { await AudioMode.setInCall({ on }); } catch (e) { console.warn("AudioMode:", e?.message || e); }
}

// Mint a signed conversation URL for a private agent using the local key. One GET;
// the key never leaves the device and the URL it returns is short-lived.
async function signedUrl(agentId, apiKey) {
  const url = `${CONFIG.ELEVEN_BASE}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`;
  const res = await fetch(url, { headers: { "xi-api-key": apiKey } });
  if (!res.ok) throw new Error(`signed-url ${res.status}: ${(await res.text()).slice(0, 140)}`);
  const body = await res.json();
  if (!body.signed_url) throw new Error("signed-url: no signed_url in response");
  return body.signed_url;
}

// startEleven — same shape as startRealtime() so main.js can swap providers.
//   instructions : the persona + functional system prompt (overrides the agent's)
//   firstMessage : optional greeting line
//   toolNames    : names of the agent's client tools to route to onToolCall
//   idleMs       : auto-stop after this long with no activity (0 disables)
export async function startEleven({ instructions, firstMessage, toolNames = [], onToolCall, onUserText, onBotText, log, onIdle, idleMs = 90_000 }) {
  const agentId = (CONFIG.ELEVEN_AGENT_ID || "").trim();
  const apiKey = (CONFIG.ELEVEN_KEY || "").trim();
  if (!agentId || !apiKey) throw new Error("add your ElevenLabs key + agent id in Settings");

  log("status", "minting signed url…");
  const url = await signedUrl(agentId, apiKey);

  // Route every client-tool call straight into the shared dispenser tools. The
  // SDK only emits a call for a tool the agent declares (see setup-eleven-agent),
  // so this map mirrors the agent's tool list exactly.
  const clientTools = {};
  for (const name of toolNames) {
    clientTools[name] = async (params) => {
      log("tool", `${name}(${JSON.stringify(params || {})})`);
      bumpIdle();
      const r = await onToolCall(name, params || {});
      return typeof r === "string" ? r : JSON.stringify(r ?? { ok: true });
    };
  }

  let convo = null, idleTimer = null, stopped = false;
  function bumpIdle() {
    if (!idleMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { log("status", "stopped — no activity"); stop(); if (onIdle) onIdle(); }, idleMs);
  }

  // Engage the in-call audio session BEFORE the SDK opens the mic, so capture and
  // playback come up inside the communication session and the hardware AEC works.
  await setInCallAudio(true);
  log("status", "connecting…");
  try {
    convo = await Conversation.startSession({
      signedUrl: url,
      connectionType: "websocket",
      clientTools,
      // Override the agent's prompt/greeting with the live persona + dispenser
      // rules, so the character and compartment state flow from the app (the
      // agent itself just needs the tools declared + overrides enabled).
      overrides: {
        agent: {
          prompt: { prompt: instructions },
          ...(firstMessage ? { firstMessage } : {}),
          language: "en",
        },
      },
      onConnect: () => { log("status", "listening — just talk 🎙️"); bumpIdle(); },
      onDisconnect: () => { if (!stopped) { log("status", "disconnected"); stop(); if (onIdle) onIdle(); } },
      onError: (msg) => log("err", "eleven: " + (msg?.message || msg)),
      onModeChange: () => bumpIdle(),
      onMessage: ({ message, source }) => {
        if (!message) return;
        bumpIdle();
        const t = String(message).trim();
        if (source === "user") onUserText(t); else onBotText(t);
      },
    });
  } catch (e) { await stop(); throw e; } // failed start → release the audio session

  return { stop };

  async function stop() {
    if (stopped) return; stopped = true;
    clearTimeout(idleTimer);
    try { if (convo) await convo.endSession(); } catch {}
    setInCallAudio(false);
  }
}

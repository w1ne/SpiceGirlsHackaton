// tts-eleven — ElevenLabs text-to-speech, server-side. Gives the dispenser its
// character voices (per-persona) without ever shipping the ElevenLabs key in the
// APK. The phone POSTs { text, voiceId, modelId? } and gets back audio/mpeg.
//
// Deploy:  supabase functions deploy tts-eleven
// Secrets: supabase secrets set ELEVENLABS_KEY=...
// verify_jwt stays ON (default): callers present the Supabase anon JWT.
import { preflight, json, cors } from "../_shared/cors.ts";

const ELEVENLABS_KEY = Deno.env.get("ELEVENLABS_KEY") ?? "";
// turbo = low latency, cheaper credits — right for short spoken replies.
const DEFAULT_MODEL = Deno.env.get("ELEVENLABS_MODEL") ?? "eleven_turbo_v2_5";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!ELEVENLABS_KEY) return json({ error: "ELEVENLABS_KEY not configured on server" }, 500);

  let body: { text?: string; voiceId?: string; modelId?: string };
  try { body = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }

  const text = (body.text ?? "").trim();
  const voiceId = (body.voiceId ?? "").trim();
  if (!text) return json({ error: "text required" }, 400);
  if (!voiceId) return json({ error: "voiceId required" }, 400);

  // ElevenLabs' free tier intermittently rejects server-originated calls with
  // 401 "detected_unusual_activity". Retry a couple of times — it usually
  // succeeds on a later attempt. (A paid plan removes the restriction entirely.)
  let upstream: Response | null = null;
  let lastDetail = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": ELEVENLABS_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: body.modelId ?? DEFAULT_MODEL }),
      },
    );
    if (upstream.ok) break;
    lastDetail = await upstream.text();
    await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
  }

  if (!upstream || !upstream.ok) {
    return json({ error: `elevenlabs ${upstream?.status}: ${lastDetail.slice(0, 200)}` }, 502);
  }

  // Return the MP3 as base64 JSON, NOT raw binary. The phone's HTTP layer
  // (CapacitorHttp) string-encodes native responses and corrupts raw binary
  // bodies; base64 is plain ASCII and survives intact, so the app can decode it
  // and play via the Web Audio API.
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return json({ audio: btoa(bin), mime: "audio/mpeg" });
});

// eleven-signed-url — mints a short-lived ElevenLabs Conversational AI signed URL
// server-side so the xi-api-key never ships in the app (same pattern as
// realtime-token). The phone POSTs here and gets back { signed_url } for the
// WebSocket session only. The agent id lives here too, so the app needs no
// ElevenLabs config at all.
//
// Deploy:  supabase functions deploy eleven-signed-url
// Secrets: supabase secrets set ELEVENLABS_KEY=xi-... ELEVEN_AGENT_ID=agent_...
import { preflight, json } from "../_shared/cors.ts";
import { rateLimit } from "../_shared/ratelimit.ts";

const KEY = Deno.env.get("ELEVENLABS_KEY") ?? "";
const AGENT_ID = Deno.env.get("ELEVEN_AGENT_ID") ?? "";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const limited = await rateLimit(req, "el", 10); // 10 voice sessions / 60s / IP
  if (limited) return limited;

  if (!KEY || !AGENT_ID) {
    return json({ error: "ELEVENLABS_KEY / ELEVEN_AGENT_ID not configured on server" }, 500);
  }

  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(AGENT_ID)}`,
    { headers: { "xi-api-key": KEY } },
  );
  const data = await res.text();
  if (!res.ok) return json({ error: `elevenlabs ${res.status}: ${data.slice(0, 160)}` }, 502);
  // ElevenLabs returns { signed_url }; pass it straight through to the client.
  return new Response(data, {
    status: 200,
    headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
  });
});

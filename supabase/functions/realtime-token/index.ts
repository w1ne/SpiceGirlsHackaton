// realtime-token — mints a short-lived OpenAI Realtime client secret server-side
// so the long-lived OPENAI_KEY never ships in the APK. The phone calls this, gets
// back { value }, and uses that ephemeral token for the WebRTC session only.
//
// Deploy:  supabase functions deploy realtime-token
// Secrets: supabase secrets set OPENAI_KEY=sk-...
import { preflight, json } from "../_shared/cors.ts";
import { rateLimit } from "../_shared/ratelimit.ts";

const OPENAI_KEY = Deno.env.get("OPENAI_KEY") ?? "";
const REALTIME_MODEL = Deno.env.get("REALTIME_MODEL") ?? "gpt-realtime";
const REALTIME_VOICE = Deno.env.get("REALTIME_VOICE") ?? "marin";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const limited = await rateLimit(req, "rt", 10); // 10 voice sessions / 60s / IP
  if (limited) return limited;

  if (!OPENAI_KEY) return json({ error: "OPENAI_KEY not configured on server" }, 500);

  // The phone may request a per-persona voice; fall back to the configured default.
  let voice = REALTIME_VOICE;
  try { const b = await req.json(); if (b && typeof b.voice === "string" && b.voice) voice = b.voice; } catch { /* no body */ }

  const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      session: { type: "realtime", model: REALTIME_MODEL, audio: { output: { voice } } },
    }),
  });

  const data = await res.text();
  if (!res.ok) return json({ error: `openai ${res.status}: ${data.slice(0, 160)}` }, 502);
  return new Response(data, {
    status: 200,
    headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
  });
});

// Per-IP, per-function rate limiting backed by the rate_limits table + rl_check()
// RPC (see migrations/0003_rate_limit.sql). Call at the top of a function:
//
//   const limited = await rateLimit(req, "llm", 30);  // 30 req / 60s / IP
//   if (limited) return limited;
//
// Fails OPEN (returns null) on any error — a limiter hiccup must never block
// legitimate traffic.
import { json } from "./cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  return xff.split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "unknown";
}

export async function rateLimit(
  req: Request,
  name: string,
  limit: number,
  windowSecs = 60,
): Promise<Response | null> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null; // not configured → don't block
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rl_check`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_key: `${name}:${clientIp(req)}`,
        p_limit: limit,
        p_window_secs: windowSecs,
      }),
    });
    if (!res.ok) return null; // fail open
    const allowed = await res.json();
    if (allowed === false) {
      return json({ error: "Too many requests — slow down and try again shortly." }, 429);
    }
    return null;
  } catch {
    return null; // fail open
  }
}

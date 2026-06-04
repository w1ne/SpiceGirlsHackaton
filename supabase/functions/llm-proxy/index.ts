// llm-proxy — the dispenser's "brain" call, server-side.
//
// The phone POSTs { messages, tools, tool_choice?, temperature? }. This function
// adds the provider API key (held as a Supabase secret, NEVER in the APK) and
// forwards to an OpenAI-compatible chat/completions endpoint, returning the raw
// completion. Prefers OpenAI when OPENAI_KEY is set, else DeepInfra.
//
// Deploy:  supabase functions deploy llm-proxy
// Secrets: supabase secrets set OPENAI_KEY=sk-...   (or)
//          supabase secrets set DEEPINFRA_KEY=...
// verify_jwt stays ON (default): callers must present the Supabase anon JWT.
import { preflight, json } from "../_shared/cors.ts";

const OPENAI_KEY = Deno.env.get("OPENAI_KEY") ?? "";
const DEEPINFRA_KEY = Deno.env.get("DEEPINFRA_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";
const DEEPINFRA_MODEL = Deno.env.get("LLM_MODEL") ?? "meta-llama/Meta-Llama-3.1-8B-Instruct";

function target() {
  if (OPENAI_KEY) return { url: "https://api.openai.com/v1/chat/completions", key: OPENAI_KEY, model: OPENAI_MODEL };
  if (DEEPINFRA_KEY) return { url: "https://api.deepinfra.com/v1/openai/chat/completions", key: DEEPINFRA_KEY, model: DEEPINFRA_MODEL };
  return null;
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const t = target();
  if (!t) return json({ error: "no LLM key configured on server" }, 500);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }

  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const payload: Record<string, unknown> = {
    model: t.model,
    temperature: typeof body.temperature === "number" ? body.temperature : 0.4,
    messages: body.messages ?? [],
  };
  // tool_choice is only valid when tools are present (OpenAI 400s otherwise).
  if (hasTools) { payload.tools = body.tools; payload.tool_choice = body.tool_choice ?? "auto"; }

  const upstream = await fetch(t.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${t.key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
  });
});

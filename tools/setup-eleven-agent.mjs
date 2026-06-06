#!/usr/bin/env node
// One-time setup: create (or update) the ElevenLabs Conversational AI agent the
// app talks to. It declares the dispenser CLIENT TOOLS (so the agent is allowed
// to call dispense/set_compartments/… on the phone) and ENABLES prompt/first-
// message/language overrides (so the app can push the live persona + compartment
// state per conversation). The tool list is generated from the app's single
// source of truth — app/src/tools.js TOOL_DEFS — so it can never drift.
//
//   ELEVENLABS_API_KEY=xi-... node tools/setup-eleven-agent.mjs
//   ELEVENLABS_API_KEY=xi-... node tools/setup-eleven-agent.mjs --update agent_123
//
// On success it prints the agent id. The runtime key + agent id live SERVER-SIDE
// in the eleven-signed-url edge function, so register them as Supabase secrets:
//   supabase secrets set ELEVENLABS_KEY=xi-... ELEVEN_AGENT_ID=<printed id>
//   supabase functions deploy eleven-signed-url
import { TOOL_DEFS } from "../app/src/tools.js";

const KEY = process.env.ELEVENLABS_API_KEY || "";
if (!KEY) { console.error("set ELEVENLABS_API_KEY=xi-... in the environment"); process.exit(1); }
const BASE = "https://api.elevenlabs.io";

const updateIdx = process.argv.indexOf("--update");
const updateId = updateIdx >= 0 ? process.argv[updateIdx + 1] : null;

// ElevenLabs' tool-parameter dialect is JSON-Schema-like but requires a
// `description` on EVERY property node (including nested array items / object
// props), or it 422s. Deep-annotate the TOOL_DEFS schema, defaulting any missing
// description to the property name so we don't have to hand-maintain a second copy.
function annotate(node, hint) {
  if (!node || typeof node !== "object") return node;
  const out = { ...node };
  if (out.type && !out.description && hint) out.description = hint;
  if (out.type === "object" && out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([k, v]) => [k, annotate(v, v.description || k)]),
    );
  }
  if (out.type === "array" && out.items) out.items = annotate(out.items, (hint || "item") + " entry");
  return out;
}

// The dispenser tools, as ElevenLabs client tools. expects_response=true so the
// agent waits for the phone's result (e.g. "dispensed" / "blocked: allergen").
const tools = TOOL_DEFS.map((t) => ({
  type: "client",
  name: t.function.name,
  description: t.function.description,
  parameters: annotate(t.function.parameters, t.function.name + " parameters"),
  expects_response: true,
  response_timeout_secs: 15,
}));

// Minimal base prompt — the APP overrides this with the live persona + dispenser
// rules every conversation, so this is only a fallback if overrides are off.
const basePrompt =
  "You are the voice of a smart spice dispenser. When the cook clearly asks for a " +
  "spice and amount, call the dispense tool. Keep replies short and spoken.";

const body = {
  name: "SpiceDispenser",
  conversation_config: {
    agent: {
      first_message: "Hi! What are you cooking? Tell me a spice and how much.",
      language: "en",
      prompt: { prompt: basePrompt, tools },
    },
  },
  // Allow the client to override these fields per conversation (off by default
  // for safety). Without this, the app's persona prompt is silently ignored.
  platform_settings: {
    overrides: {
      conversation_config_override: {
        agent: { prompt: { prompt: true }, first_message: true, language: true },
      },
    },
  },
};

const url = updateId
  ? `${BASE}/v1/convai/agents/${updateId}`
  : `${BASE}/v1/convai/agents/create`;
const method = updateId ? "PATCH" : "POST";

const res = await fetch(url, {
  method,
  headers: { "xi-api-key": KEY, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const text = await res.text();
if (!res.ok) {
  console.error(`ElevenLabs ${method} ${res.status}:\n${text}`);
  console.error("\nIf the tool/override schema was rejected, the dashboard works too:");
  console.error("  Agents → your agent → Tools: add client tools 'dispense' + 'set_compartments'");
  console.error("  Agents → your agent → Security: enable System prompt / First message overrides");
  process.exit(1);
}
let agentId = updateId;
try { agentId = JSON.parse(text).agent_id || updateId; } catch {}
console.log(`✅ agent ${updateId ? "updated" : "created"}: ${agentId}`);
console.log(`   tools declared: ${tools.map((t) => t.name).join(", ")}`);
console.log(`\nRegister server-side, then deploy:`);
console.log(`   supabase secrets set ELEVENLABS_KEY=<the xi-api-key> ELEVEN_AGENT_ID=${agentId}`);
console.log(`   supabase functions deploy eleven-signed-url`);
console.log(`Then pick "Natural — ElevenLabs voice" in the app — no app config needed.`);

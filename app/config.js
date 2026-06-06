// Client-public config. Supabase anon key is meant to ship in the client.
//
// PROXY mode (default): the LLM call and the realtime token are minted by
// Supabase Edge Functions (llm-proxy / realtime-token) that hold the provider
// keys server-side — so NO OpenAI/DeepInfra key ships in the APK. The VITE_*
// key fields below stay empty in production; they exist only as a local-dev
// fallback when you set VITE_PROXY=0 and bake keys into .env.local.
const SUPABASE_URL = "https://tlgtyskedenqffikfuzx.supabase.co";
export const CONFIG = {
  // App version — shown in Settings and bumped on every release. Keep in sync
  // with package.json + the GitHub release tag (vX.Y.Z).
  APP_VERSION: "1.5.2",
  SUPABASE_URL,
  // Route the brain + realtime token through edge functions unless explicitly off.
  PROXY: (import.meta.env.VITE_PROXY ?? "1") !== "0",
  // Edge-function base. Defaults to the hosted project; override with
  // VITE_FN_BASE (e.g. a locally-served function) for local end-to-end testing.
  FN_BASE: import.meta.env.VITE_FN_BASE || `${SUPABASE_URL}/functions/v1`,
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRsZ3R5c2tlZGVucWZmaWtmdXp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1NTg4NDMsImV4cCI6MjA5NjEzNDg0M30.Pkb2WU2Mh7U3gbseRZPQ_B56Lt6VA_rY8oUR3FQetLY",
  DEVICE_ID: "dispenser-01",
  // BLE GATT profile — must match the ESP32 firmware
  BLE_SERVICE: "a1c20000-d8e4-4f9b-9b1a-2f3c4d5e6f70",
  BLE_CMD: "a1c20001-d8e4-4f9b-9b1a-2f3c4d5e6f70",
  BLE_STATUS: "a1c20002-d8e4-4f9b-9b1a-2f3c4d5e6f70",
  // Known dispenser address (Android deviceId == MAC). When set, the app connects
  // WITHOUT scanning, sidestepping Android's BLE scan throttle. Empty by default
  // so a SHARED build works with ANY dispenser (it scans + matches by name, then
  // remembers the address). Pin your own board with VITE_BLE_DEVICE_ID in .env.local.
  BLE_DEVICE_ID: import.meta.env.VITE_BLE_DEVICE_ID ?? "",
  // LLM brain. In normal use the app calls the llm-proxy / realtime-token edge
  // functions, which hold the provider key SERVER-SIDE — no OpenAI/DeepInfra key
  // ever ships in the app. OPENAI_BASE is only the public realtime endpoint used
  // for the WebRTC SDP exchange (the ephemeral token comes from the edge fn).
  OPENAI_BASE: "https://api.openai.com/v1",
  // Full gpt-realtime, not -mini: the mini model intermittently SAYS "done"
  // without ever calling the dispense tool (nothing reaches the motors) and
  // acts on overheard conversation. Tool discipline is the product here.
  REALTIME_MODEL: "gpt-realtime",
  REALTIME_VOICE: "marin",
  // ElevenLabs Conversational AI is a selectable voice provider (see eleven.js).
  // Like the OpenAI path, its key + agent id live SERVER-SIDE in the
  // eleven-signed-url edge function — nothing ElevenLabs ships in the app, so
  // there's no client config here.
  // Local-dev-only direct LLM fallback (VITE_PROXY=0). The key is NEVER baked —
  // a developer types it into Settings, where it stays in their browser only.
  DEEPINFRA_BASE: "https://api.deepinfra.com/v1/openai",
  LLM_MODEL: "meta-llama/Meta-Llama-3.1-8B-Instruct",
};

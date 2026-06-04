// Client-public config. Supabase anon key is meant to ship in the client.
// The DeepInfra key is entered at runtime (Phase 2 voice), never committed.
export const CONFIG = {
  SUPABASE_URL: "https://tlgtyskedenqffikfuzx.supabase.co",
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRsZ3R5c2tlZGVucWZmaWtmdXp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1NTg4NDMsImV4cCI6MjA5NjEzNDg0M30.Pkb2WU2Mh7U3gbseRZPQ_B56Lt6VA_rY8oUR3FQetLY",
  DEVICE_ID: "dispenser-01",
  // BLE GATT profile — must match the ESP32 firmware
  BLE_SERVICE: "a1c20000-d8e4-4f9b-9b1a-2f3c4d5e6f70",
  BLE_CMD: "a1c20001-d8e4-4f9b-9b1a-2f3c4d5e6f70",
  BLE_STATUS: "a1c20002-d8e4-4f9b-9b1a-2f3c4d5e6f70",
  // LLM brain. Keys baked from .env.local at build time (Vite inlines VITE_*).
  // Prefer OpenAI when its key is present (cleaner tool-calling), else DeepInfra.
  OPENAI_BASE: "https://api.openai.com/v1",
  OPENAI_MODEL: "gpt-4o-mini",
  OPENAI_KEY: import.meta.env.VITE_OPENAI_KEY || "",
  REALTIME_MODEL: "gpt-realtime-mini",
  REALTIME_VOICE: "marin",
  DEEPINFRA_BASE: "https://api.deepinfra.com/v1/openai",
  LLM_MODEL: "meta-llama/Meta-Llama-3.1-8B-Instruct",
  DEEPINFRA_KEY: import.meta.env.VITE_DEEPINFRA_KEY || "",
};

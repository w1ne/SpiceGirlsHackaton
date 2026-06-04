// Client-public config. The Supabase anon key is meant to ship in the browser
// (it's gated by RLS). The DeepInfra key is NOT here — it's entered at runtime
// and kept in localStorage, never committed.
export const CONFIG = {
  SUPABASE_URL: "https://tlgtyskedenqffikfuzx.supabase.co",
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRsZ3R5c2tlZGVucWZmaWtmdXp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1NTg4NDMsImV4cCI6MjA5NjEzNDg0M30.Pkb2WU2Mh7U3gbseRZPQ_B56Lt6VA_rY8oUR3FQetLY",
  DEVICE_ID: "dispenser-01",
  // DeepInfra OpenAI-compatible endpoints
  DEEPINFRA_BASE: "https://api.deepinfra.com/v1/openai",
  STT_MODEL: "openai/whisper-large-v3-turbo",
  LLM_MODEL: "meta-llama/Meta-Llama-3.1-8B-Instruct",
};

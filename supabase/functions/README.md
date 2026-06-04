# Edge functions — keep provider keys off the phone (#2)

The app runs in **PROXY mode** by default (`CONFIG.PROXY`). The phone never holds
an OpenAI/DeepInfra key; instead it calls these functions, which hold the keys as
Supabase secrets.

| Function | Used by | What it does |
|---|---|---|
| `llm-proxy` | classic voice / chat `llmStep()` | forwards messages+tools to the LLM with the server-held key |
| `realtime-token` | realtime voice `startRealtime()` | mints a short-lived OpenAI Realtime client secret |

## Deploy

```bash
# from repo root, with the Supabase CLI linked to the project
supabase functions deploy llm-proxy
supabase functions deploy realtime-token

# set the provider key(s) as secrets (NOT in the app)
supabase secrets set OPENAI_KEY=sk-...           # enables OpenAI + realtime voice
# or, for the cheaper text path only:
supabase secrets set DEEPINFRA_KEY=...
# optional overrides: OPENAI_MODEL, LLM_MODEL, REALTIME_MODEL, REALTIME_VOICE
```

`verify_jwt` stays on (default): callers must present the Supabase anon JWT, which
the app already sends. To run the app against baked keys for local dev instead,
build with `VITE_PROXY=0` and put `VITE_OPENAI_KEY` / `VITE_DEEPINFRA_KEY` in
`app/.env.local`.

# Sharing the app with your team

The app is safe to share. **No provider keys (OpenAI / DeepInfra / ElevenLabs)
are ever in the APK** — they live only as Supabase Edge Function secrets on the
server. The only credential baked into the build is the **Supabase anon key**,
which is *designed* to ship in clients (it's a public, scoped token).

## Fastest: share the APK file

1. Build it (one command):
   ```bash
   cd app && npm install && npm run apk
   ```
   This produces **`SpiceGirls.apk`** in the repo root.
2. Send that `.apk` to your team (Slack/Drive/etc.).
3. They install it on Android (allow "install from this source" when prompted).

Everyone who installs it talks to **your** Supabase + edge functions, so the
brain/voice work out of the box with no setup on their end. Each phone pairs to
whatever dispenser is in range (it scans by name, then remembers the address).

## What's inside the APK (and what isn't)

| In the APK (safe) | NOT in the APK (server-side only) |
|---|---|
| Supabase URL | `OPENAI_KEY` |
| Supabase **anon** key (public by design) | `DEEPINFRA_KEY` |
| BLE service UUIDs | Supabase **service-role** key |

Verify any build yourself:
```bash
cd app && npm run build && grep -rE 'sk-[A-Za-z0-9]|DEEPINFRA' dist/ || echo "clean — no provider keys"
```

## Trust model (read before sharing widely)

The anon key lets the holder call your edge functions, which spend **your**
OpenAI/DeepInfra credits. That's fine for a **trusted team**. Before sharing
outside one, add protection so a leaked APK can't run up your bill:

- **Rate-limit** the `llm-proxy` / `realtime-token` functions (per IP/user, daily cap).
- Set **hard spend caps** on the OpenAI & DeepInfra dashboards as a backstop.
- For real per-user accounts, switch the anon key for **Supabase Auth** JWTs.
- Apply `supabase/migrations/0002_tighten_rls.sql` to lock the database down.

## Standing up your own backend (optional)

If a teammate wants their *own* server instead of yours:

1. Create a Supabase project; put its URL + anon key in `app/config.js`.
2. Deploy the functions and set the secrets (keys never touch the repo):
   ```bash
   supabase functions deploy llm-proxy
   supabase functions deploy realtime-token
   supabase secrets set OPENAI_KEY=sk-...        # or DEEPINFRA_KEY=...
   ```
3. Run the DB migrations in `supabase/migrations/`.
4. `npm run apk` and share.

## Secrets hygiene

- `app/.env.local` is git-ignored and only used for **local dev** (`VITE_PROXY=0`
  to call providers directly). Never commit real keys; production builds leave
  those fields empty and use the edge functions.
- The build output `SpiceGirls.apk` is git-ignored — share the file, don't commit it.

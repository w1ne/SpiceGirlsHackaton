# SpiceDispenser — Phone ↔ ESP32 Interface Design

**Date:** 2026-06-04
**Status:** Draft for review (hackathon project — "SpiceGirls")
**Repo:** git@github.com:w1ne/SpiceGirlsHackaton.git

## Goal

A voice-driven smart spice dispenser. You talk to it ("I'm making chili for 4,
medium heat"), it asks clarifying questions, then physically dispenses the right
spices. The **primary deliverable of this spec is a precisely-defined interface
between the ESP32 firmware and the phone app** so the two can be built in
parallel by separate people against a fixed contract.

## Constraints / context

- **Hackathon:** optimize for "reliably impressive on stage," not robustness.
- Hardware: ESP32 (C3 or S3) + **two servos** — a *revolver servo* (rotates the
  carousel to select a spice slot) and a *dispense servo* (sweeps to drop a dose).
- **Timed/step dosing, no scale.** Dose is expressed in discrete "sweeps" of the
  dispense servo. There is **no weight feedback**.
- Phone holds all intelligence + the mic and speaker. ESP32 is a dumb actuator.
- Need to persist user **recipes and preferences**.

## Architecture

Both the phone and the ESP32 make **only outbound connections to Supabase**.
Neither needs to discover the other on the LAN. Supabase Postgres stores
recipes/preferences AND acts as the message bus (one dependency, two problems
solved).

```
┌─────────────┐         ┌──────────────────┐         ┌──────────────┐
│  Phone App  │◄──────► │     Supabase     │ ◄────── │    ESP32     │
│ mic+speaker │ Realtime│ Postgres+Realtime│  HTTPS  │  2 servos    │
│ STT·LLM·TTS │  + REST │  + REST + Auth   │  poll   │ revolver+drop│
└─────────────┘         └──────────────────┘         └──────────────┘
   DeepInfra            recipes, prefs,
                        command queue, devices
```

### Why Supabase over local networking

Hackathon WiFi almost always has **AP client isolation** (phone can't reach the
ESP32's LAN IP) and unreliable mDNS, so a local WebSocket/HTTP link frequently
fails — at demo time. Outbound-only-to-cloud sidesteps discovery entirely. Since
a DB was needed for recipes/prefs anyway, Supabase covers both.

**Tradeoff:** requires working *outbound internet* at the venue, and adds
~0.5–1 s command latency from ESP32 polling. See Risks for the captive-portal
and TLS caveats (these are the real dangers).

### Three independently-buildable units

1. **ESP32 firmware** — WiFi → Supabase over HTTPS. Polls the command queue,
   drives the two servos, reports status + heartbeat. Zero inbound connections.
2. **Phone app** — mic+speaker; STT → clarifying-question LLM → TTS, all on
   DeepInfra. Talks only to Supabase: CRUD recipes/prefs, insert dispense
   commands, watch their status live via Realtime.
3. **Supabase** — the contract below; lets units 1 and 2 be built in parallel.

## The interface (the contract)

### Table: `devices`
| field | type | notes |
|---|---|---|
| device_id | text (pk) | e.g. `"dispenser-01"` |
| name | text | display name |
| slots | jsonb | slot→spice map, e.g. `{"0":"paprika","1":"cumin","2":"salt"}` |
| last_seen | timestamptz | heartbeat |

### Table: `commands` — the queue, heart of the interface
| field | type | notes |
|---|---|---|
| id | uuid (pk) | default gen_random_uuid() |
| device_id | text | target dispenser |
| type | text | `dispense` \| `home` \| `ping` |
| payload | jsonb | for `dispense`: `{ "slot": 2, "dose_units": 3 }` |
| status | text | `pending` → `running` → `done` \| `error` |
| error | text | null unless failed |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | set on each transition |

**`dose_units` definition (fixed in the contract, NOT firmware mood):**
`dose_units = N` means the dispense servo performs **N full sweeps** of the
calibrated dispense motion for that slot. One sweep is a firmware-fixed angle
arc and dwell. The grams-per-sweep mapping per spice is calibrated separately
(see Risks) and lives in app/recipe data, not in the command — the command only
ever speaks in sweeps.

### Table: `recipes`
| field | type | notes |
|---|---|---|
| id | uuid (pk) | |
| name | text | "Taco night" |
| steps | jsonb | `[{ "slot": 0, "dose_units": 2 }, ...]` |

### Table: `preferences`
| field | type | notes |
|---|---|---|
| user_id | text | hackathon: single shared id (TBD, see open questions) |
| key | text | `spice_tolerance`, `default_servings`, `dietary` |
| value | text | |

### Status lifecycle
`pending` → ESP32 claims it (`running`) → actuates → `done` or `error`.

### ESP32 contract
- On boot: upsert own row in `devices`; heartbeat `last_seen` every N seconds.
- **Atomically claim** one pending command:
  `UPDATE commands SET status='running', updated_at=now()
   WHERE id = (SELECT id FROM commands WHERE device_id=$me AND status='pending'
               ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`
  (exposed via an RPC / PostgREST). This prevents double-dispense on
  re-poll/reconnect.
- Execute: `dispense` → rotate revolver to slot angle → pulse dispense servo
  `dose_units` times. `home` → return revolver to zero. `ping` → no-op ack.
- Set `done`, or `error` + message on failure.

### Phone contract
- CRUD on `recipes` / `preferences`.
- To dispense: insert one `commands` row per step.
- Subscribe to Realtime on `commands` (filtered to the device) for live status;
  speak the result via TTS.
- **Demo-mode escape hatch:** a button that inserts the dispense command(s)
  directly, bypassing mic/STT/LLM (see Risks).

## Conversation flow (phone, all DeepInfra)

1. Push-to-talk → record.
2. **STT** (DeepInfra Whisper) → text.
3. **LLM** (DeepInfra open model) with a system prompt that asks clarifying
   questions — *what dish? how many servings? spice tolerance?* — then maps the
   answer to slots + `dose_units` and emits a structured dispense plan.
4. Phone inserts the plan as `commands` rows → ESP32 dispenses.
5. **TTS** speaks the questions/confirmations.

## Risks (from design roast — read before building)

1. **Captive portals / venue internet.** The ESP32 can't click "accept terms."
   If the venue WiFi is captive, the dispenser is bricked. **Mitigation:** bring
   a controlled phone hotspot; test end-to-end before arrival.
2. **TLS on ESP32.** Supabase is HTTPS-only; bundling a CA root + handshake RAM
   on a C3 is the riskiest firmware. Pin a current root bundle; verify well
   before demo. (If it proves too painful, a self-run HTTP relay is the fallback.)
3. **Queue race / double-dispense.** Must use the atomic claim above. Double
   dose = ruined dish on stage.
4. **`dose_units` is uncalibrated.** Sweep→grams differs per spice, fill level,
   humidity. LLM precision claims are theater. Pre-calibrate the demo spices;
   present amounts as approximate.
5. **Scope creep in the voice dialogue.** Highest-polish-temptation, lowest
   judge-credit-per-hour vs. spice physically dropping. Time-box it.
6. **Mechanical dispensing is the real 20%.** Powder bridging/clumping; a servo
   paddle may not flow reliably. No firmware fixes clumpy paprika. Bench-test early.
7. **Voice loop latency + noise.** Loud demo room + multi-second round trips per
   turn. Keep turns minimal; rely on the demo-mode escape hatch.

## De-risking priority order (proposed)

1. **Day 1 — scary leg first:** ESP32 → Supabase → servo moves, triggered by a
   *hand-inserted* command row. No app, no voice. Prove TLS + queue + servo.
2. Mechanical: reliably drop one spice from one slot. Calibrate sweeps.
3. Phone app: insert commands + Realtime status + demo-mode button (no voice yet).
4. Voice loop (STT→LLM→TTS) on the one pre-scripted demo dish.
5. Polish: multi-spice recipes, preferences, nicer TTS.

## Open questions

- **Auth:** real Supabase Auth (per-user) vs. single hardcoded shared `user_id`.
  Recommendation for hackathon: single shared id.
- **TTS:** local on-phone (instant, offline, robotic) vs. DeepInfra (nicer,
  network round-trip). Recommendation: local for reliability, DeepInfra if time.
- **Which de-risk leg** (ESP32→cloud / mechanical / voice) scares you most —
  reorders the priority list above.
- Phone app stack (native / React Native / Expo / Flutter / PWA) — TBD.

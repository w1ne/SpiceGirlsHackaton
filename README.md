# SpiceDispenser 🌶️ (SpiceGirls Hackathon)

Voice-driven smart spice dispenser. Talk to it, it asks clarifying questions,
then dispenses the right spices.

- **Phone app** — mic + speaker; speech-to-text → clarifying-question LLM →
  text-to-speech, all on DeepInfra. Holds all the intelligence.
- **ESP32 (C3/S3)** — dumb actuator with two servos (revolver select + dispense).
- **Supabase** — Postgres for recipes/preferences + the command-queue message
  bus between phone and device. Both sides connect *outbound only* (no LAN
  discovery, survives client-isolated WiFi).

## The interface

The contract that lets the firmware and app be built in parallel lives in
[`docs/superpowers/specs/2026-06-04-spice-dispenser-interface-design.md`](docs/superpowers/specs/2026-06-04-spice-dispenser-interface-design.md).

## Setup

```bash
cp .env.example .env   # then fill in your keys (.env is git-ignored)
```

Secrets never get committed — see `.gitignore`.

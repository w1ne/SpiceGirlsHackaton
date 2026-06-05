# Changelog

Versions track the Android app (`SpiceGirls.apk`). Each release is tagged
`vX.Y.Z` on GitHub with the APK attached — download the latest from the
[releases page](https://github.com/w1ne/SpiceGirlsHackaton/releases/latest).
The running version is shown in the app under **Settings**.

## v1.1.1

- **Voice starts instantly.** Tapping "Start talking" no longer waits for the
  Bluetooth connect ladder (up to ~40 s when the dispenser is off) — the voice
  session and the BLE connection now start in parallel, so the greeting lands
  in a couple of seconds and dispensing still re-verifies the link first.
- **The bot no longer hears itself.** Android's echo cancellation doesn't
  reliably cover the voice playback path, so the open mic picked up the bot's
  own speaker voice — it interrupted itself mid-sentence, transcribed phantom
  "user" turns and even dispensed spices nobody asked for. The mic now mutes
  the instant a reply starts (before audio reaches the speaker) and reopens
  shortly after it ends. Trade-off: you can't talk over the bot — wait for it
  to finish.
- **Kitchen-proof hearing.** Switched to semantic turn detection (the model
  ends your turn by what you said, not by room loudness), far-field noise
  reduction for a counter-top phone, and a better transcriber — so clatter
  stops triggering replies, transcripts stop inventing words, and answers
  come faster after you finish a sentence.
- **One voice, ever.** Fixed two voices talking at the same time: tapping Stop
  while the realtime session was still connecting left it running with no
  handle, and the next tap started a second one on top. A single voice-session
  gate now makes a tap during startup an honest Stop (the in-flight session is
  killed the moment it lands) and a second concurrent session impossible.
  Double-taps can't spawn duplicate listen loops in classic mode either,
  typed-command replies stay silent while a realtime voice is live (no
  device-TTS layered on top), and a failed realtime start releases the mic
  instead of leaving it hot.

## v1.1.0

- **Honest BLE connection.** The app verifies it's *really* connected (against
  the OS connection list) before each dispense, and each dispense waits for the
  firmware's reply — silence now shows an error + reconnects instead of a fake
  "✓ done".
- **LED link indicator.** The dispenser breathes **green** while a phone is
  connected (solid **blue** = advertising, **white** = dispensing). Fixed the
  WS2812 GRB color order (green was showing red).
- **Tighter voice loop.** Terse, stops talking after dispensing, and ignores
  unrelated overheard conversation; realtime VAD made less trigger-happy.
- **Shareable + safe.** One-command `npm run apk`; no provider keys in the build
  (proxy-only); pairs with any dispenser by default.
- **Backend hardening.** Per-IP rate limiting on `llm-proxy` / `realtime-token`;
  RLS tightened so the anon key can't delete data.

## v1.0

- First shareable build: voice/text control, character personas, BLE dispense,
  Supabase-hosted brain, downloadable APK.

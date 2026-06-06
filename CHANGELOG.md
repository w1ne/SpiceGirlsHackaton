# Changelog

Versions track the Android app (`SpiceGirls.apk`). Each release is tagged
`vX.Y.Z` on GitHub with the APK attached — download the latest from the
[releases page](https://github.com/w1ne/SpiceGirlsHackaton/releases/latest).
The running version is shown in the app under **Settings**.

## v1.4.0

- **Calibrate from the app.** **Settings → 🛠 Calibration & test** brings the
  whole bench console to the phone, over Bluetooth: live hardware status,
  per-compartment test dispense, raw carousel jog, shutter/PCA/LED controls,
  and the full calibration card (home the carousel, timing, shutter angles)
  with save-to-board — no laptop or USB cable needed.
- **Choose the revolver drive.** The calibration menu now selects what rotates
  the carousel: **auto** (bus servo if found, else PWM spin — the previous
  behavior and still the default), **bus servo (STS3215)**, **continuous spin
  (MG90S-360)**, or **positional 180° servo**. Persisted per board.
- **Servo speeds are calibratable.** Bus-servo goal speed + acceleration and
  the PWM-360 spin pulse width are now part of the calibration (applied live,
  persisted), instead of compile-time constants.
- **Firmware: full console dialect over BLE.** The command characteristic now
  accepts the same `{"cmd":...}` JSON as the USB serial console, with replies
  notified back — this is what powers the in-app screen. Dispense commands and
  voice are unchanged (voice still can't touch calibration).

## v1.3.1

- **Unpair a dispenser.** A new "Unpair dispenser" button in **Settings** forgets
  the currently paired board so you can connect a different one — previously the
  app stuck to the first dispenser it paired with, which got in the way when you
  have several units. (App only — no firmware change.)

## v1.3.0

- **ElevenLabs voice.** A new voice option in **Settings** — talk to the
  dispenser through ElevenLabs Conversational AI instead of the default voice.
  Same hands-free flow; the provider key stays server-side.
- **Calibrate once, and it sticks.** The dispenser now remembers its mechanical
  calibration (carousel home position, rotation timing, shutter open/close
  angles) across reboots. Set it from the serial console — a new Calibration
  card reads and writes the values — so a freshly built or re-built unit lines
  up the compartments without reflashing.
- **Run several dispensers side by side.** Each board now advertises a unique
  name and keeps its own compartment setup, so multiple prototypes no longer
  overwrite each other's spice layout. Just flash and go — every unit gets its
  own identity automatically.
- **Firmware now reports its version + unit id** over USB serial, so you can
  tell at a glance which board is which and what it's running.

## v1.2.1

- **Hears you better in a loud kitchen.** Enables the platform's voice
  isolation where the WebView supports it, and the turn detector is now
  patient with slow, thinking speech ("two pinches of… ehm…") instead of
  cutting the phrase at the pause. Replies start a beat later in exchange.
- **Always the loudspeaker.** Voice sessions pin playback to the built-in
  loudspeaker — a paired watch/earbuds could silently steal the audio
  route and leave the voice whispering out of the earpiece.

## v1.2.0

- **Hell's Kitchen mode.** 🔥 toggle in the header: the dispenser plays real
  Gordon Ramsay clips at random moments while you cook, plus a jab right
  after each dispense. Pauses automatically during voice conversations so
  the AI doesn't argue with Gordon. Clips aren't in the repo — run
  `tools/fetch-ramsay.sh` before building (private assets repo first,
  public soundboards as fallback).

## v1.1.1

- **Voice starts instantly.** Tapping "Start talking" no longer waits for the
  Bluetooth connect ladder (up to ~40 s when the dispenser is off) — the voice
  session and the BLE connection now start in parallel, so the greeting lands
  in a couple of seconds and dispensing still re-verifies the link first.
- **Full-duplex voice, like a phone call.** The voice session now runs in
  Android's voice-communication audio mode (native plugin), engaging the
  hardware echo canceller — the bot no longer hears its own speaker voice, you
  can talk over it to interrupt (barge-in), and no muting tricks are needed.
  Previously the open mic picked up the bot's own audio: it interrupted itself
  mid-sentence, transcribed phantom "user" turns and even dispensed from them.
- **No more fake "done".** Upgraded the voice brain to the full realtime model:
  the mini model intermittently *said* "spices dispensed — done" without ever
  calling the dispense tool, so nothing reached the motors. The firmware now
  also verifies every servo command on the I2C bus and reports "servos not
  responding — check dispenser power" instead of pretending success when the
  servo rail is unpowered.
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

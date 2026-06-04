// OpenAI Realtime voice over WebRTC, wired to the dispenser tool surface.
// Speech-to-speech: mic audio streams up, model audio plays back, and the model
// can call tools (dispense, set_compartments, …) mid-conversation.
import { CONFIG } from "../config.js";

// log(kind, text): surface progress/errors on screen (we can't see a console on device)
// idleMs: auto-stop the session after this long with no speech, so an always-on
// mic isn't a battery/$$ leak (realtime is billed per minute). onIdle fires so
// the caller can reset its UI. Default 90s; pass 0 to disable.
export async function startRealtime({ instructions, tools, voice, onToolCall, onUserText, onBotText, log, onIdle, idleMs = 90_000 }) {
  log("status", "minting realtime token…");
  const voiceName = voice || CONFIG.REALTIME_VOICE;
  // 1) ephemeral token. PROXY mode mints it via the realtime-token edge function
  // (server holds the OpenAI key); dev fallback uses the baked key directly.
  const tokRes = CONFIG.PROXY
    ? await fetch(`${CONFIG.FN_BASE}/realtime-token`, {
        method: "POST",
        headers: { Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ voice: voiceName }),
      })
    : await fetch(`${CONFIG.OPENAI_BASE}/realtime/client_secrets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          session: { type: "realtime", model: CONFIG.REALTIME_MODEL, audio: { output: { voice: voiceName } } },
        }),
      });
  if (!tokRes.ok) throw new Error(`token ${tokRes.status}: ${(await tokRes.text()).slice(0, 140)}`);
  const EPH = (await tokRes.json()).value;

  // 2) WebRTC peer connection + mic + speaker
  log("status", "opening mic…");
  const pc = new RTCPeerConnection();
  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  document.body.appendChild(audioEl);
  pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; const p = audioEl.play(); if (p) p.catch(() => {}); };
  pc.onconnectionstatechange = () => log("status", "webrtc: " + pc.connectionState);

  // Explicit echo cancellation so the open mic doesn't pick up the bot's own
  // voice over the speaker and make it interrupt/talk over itself.
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  mic.getTracks().forEach((t) => pc.addTrack(t, mic));

  // 3) data channel for events + tool calls
  const dc = pc.createDataChannel("oai-events");
  const send = (o) => { try { dc.send(JSON.stringify(o)); } catch (e) { log("err", "dc send: " + e); } };

  let pendingTool = false; // a tool ran this turn → ask for ONE follow-up at response.done
  // idle auto-stop: any speech/tool activity resets the timer; silence trips it.
  let idleTimer = null;
  const bumpIdle = () => {
    if (!idleMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { log("status", "stopped — no activity"); stop(); if (onIdle) onIdle(); }, idleMs);
  };

  dc.onopen = () => {
    send({
      type: "session.update",
      session: {
        type: "realtime", instructions, tools, tool_choice: "auto",
        // In the realtime session schema, VAD + input transcription live under
        // audio.input (NOT at the session top level — that 400s with
        // "unknown parameter: session.turn_detection").
        audio: {
          input: {
            // Higher threshold + longer silence so the mic only fires on clear,
            // close speech aimed at the dispenser — not ambient kitchen chatter.
            turn_detection: { type: "server_vad", threshold: 0.8, prefix_padding_ms: 300, silence_duration_ms: 900 },
            transcription: { model: "whisper-1" },
          },
        },
      },
    });
    // greet immediately — confirms audio-out works before the user even speaks
    send({ type: "response.create", response: { instructions: "Greet the cook in one short friendly sentence and ask what they're making." } });
    log("status", "listening — just talk 🎙️");
    bumpIdle();
  };
  dc.onmessage = async (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    switch (ev.type) {
      case "conversation.item.input_audio_transcription.completed":
        if (ev.transcript) { onUserText(ev.transcript.trim()); bumpIdle(); } break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (ev.transcript) { onBotText(ev.transcript.trim()); bumpIdle(); } break;
      case "response.function_call_arguments.done": {
        let args = {}; try { args = JSON.parse(ev.arguments || "{}"); } catch {}
        log("tool", `${ev.name}(${ev.arguments || ""})`);
        bumpIdle();
        const result = await onToolCall(ev.name, args);
        // Submit the tool result now, but DON'T request a new response yet — the
        // response that emitted this call is still active. Defer to response.done
        // so one (and only one) follow-up fires, even for multi-call turns.
        send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify(result) } });
        pendingTool = true;
        break;
      }
      case "response.done":
        if (pendingTool) { pendingTool = false; send({ type: "response.create" }); }
        break;
      case "error":
        log("err", "server: " + JSON.stringify(ev.error || ev)); break;
    }
  };

  // 4) SDP offer → answer
  log("status", "connecting…");
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdpRes = await fetch(`${CONFIG.OPENAI_BASE}/realtime/calls?model=${CONFIG.REALTIME_MODEL}`, {
    method: "POST", body: offer.sdp,
    headers: { Authorization: `Bearer ${EPH}`, "Content-Type": "application/sdp" },
  });
  if (!sdpRes.ok) throw new Error(`sdp ${sdpRes.status}: ${(await sdpRes.text()).slice(0, 140)}`);
  // CapacitorHttp's native layer can hand back the SDP with stripped/mixed line
  // endings; Chromium's parser then rejects it ("Invalid SDP line"). Force CRLF.
  // CapacitorHttp's native layer normalizes line endings and trims the trailing
  // newline off the body. SDP requires every line — including the last — to end
  // in CRLF, so we re-normalize to CRLF and guarantee a terminating CRLF, else
  // Chromium rejects the final line ("Invalid SDP line").
  let answerSdp = (await sdpRes.text()).replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  if (!answerSdp.endsWith("\r\n")) answerSdp += "\r\n";
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  return { stop };

  // hoisted so the idle timer (set up above) can call it
  function stop() {
    clearTimeout(idleTimer);
    try { mic.getTracks().forEach((t) => t.stop()); } catch {}
    try { dc.close(); } catch {}
    try { pc.close(); } catch {}
    try { audioEl.remove(); } catch {}
  }
}

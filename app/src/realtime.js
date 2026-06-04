// OpenAI Realtime voice over WebRTC, wired to the dispenser tool surface.
// Speech-to-speech: mic audio streams up, model audio plays back, and the model
// can call tools (dispense, set_compartments, …) mid-conversation.
import { CONFIG } from "../config.js";

// log(kind, text): surface progress/errors on screen (we can't see a console on device)
export async function startRealtime({ instructions, tools, onToolCall, onUserText, onBotText, log }) {
  log("status", "minting realtime token…");
  // 1) ephemeral token (uses the baked OpenAI key; CapacitorHttp → no CORS)
  const tokRes = await fetch(`${CONFIG.OPENAI_BASE}/realtime/client_secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      session: { type: "realtime", model: CONFIG.REALTIME_MODEL, audio: { output: { voice: CONFIG.REALTIME_VOICE } } },
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

  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  mic.getTracks().forEach((t) => pc.addTrack(t, mic));

  // 3) data channel for events + tool calls
  const dc = pc.createDataChannel("oai-events");
  const send = (o) => { try { dc.send(JSON.stringify(o)); } catch (e) { log("err", "dc send: " + e); } };
  dc.onopen = () => {
    send({ type: "session.update", session: { type: "realtime", instructions, tools, tool_choice: "auto" } });
    // greet immediately — confirms audio-out works before the user even speaks
    send({ type: "response.create", response: { instructions: "Greet the cook in one short friendly sentence and ask what they're making." } });
    log("status", "listening — just talk 🎙️");
  };
  dc.onmessage = async (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    switch (ev.type) {
      case "conversation.item.input_audio_transcription.completed":
        if (ev.transcript) onUserText(ev.transcript.trim()); break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (ev.transcript) onBotText(ev.transcript.trim()); break;
      case "response.function_call_arguments.done": {
        let args = {}; try { args = JSON.parse(ev.arguments || "{}"); } catch {}
        log("tool", `${ev.name}(${ev.arguments || ""})`);
        const result = await onToolCall(ev.name, args);
        send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify(result) } });
        send({ type: "response.create" });
        break;
      }
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

  return {
    stop() {
      try { mic.getTracks().forEach((t) => t.stop()); } catch {}
      try { dc.close(); } catch {}
      try { pc.close(); } catch {}
      try { audioEl.remove(); } catch {}
    },
  };
}

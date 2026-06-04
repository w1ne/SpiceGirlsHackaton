import { createClient } from "@supabase/supabase-js";
import { BleClient, textToDataView, dataViewToText } from "@capacitor-community/bluetooth-le";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { TextToSpeech } from "@capacitor-community/text-to-speech";
import { CONFIG } from "../config.js";
import { TOOL_DEFS, runTool, realtimeTools } from "./tools.js";
import { startRealtime } from "./realtime.js";

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
let slots = {}, recipes = [], messages = [];
let deviceId = null, listening = false, busy = false;

const LS = {
  get diKey() { return localStorage.getItem("di_key") || CONFIG.DEEPINFRA_KEY || ""; },
  set diKey(v) { localStorage.setItem("di_key", v); },
  get tts() { return localStorage.getItem("tts") !== "0"; },
  set tts(v) { localStorage.setItem("tts", v ? "1" : "0"); },
  // "realtime" (OpenAI speech-to-speech) or "classic" (turn-based STT→LLM→TTS)
  get voiceMode() { return localStorage.getItem("voice_mode") || (CONFIG.OPENAI_KEY ? "realtime" : "classic"); },
  set voiceMode(v) { localStorage.setItem("voice_mode", v); },
};

const $ = (s) => document.querySelector(s);
const slotsEl = $("#slots"), recipesEl = $("#recipes"), recipesWrap = $("#recipesWrap"),
      statusEl = $("#status"), interimEl = $("#interim"), chatEl = $("#chat"),
      bleBtn = $("#bleBtn"), micBtn = $("#micBtn");

const status = (m, c = "") => (statusEl.innerHTML = `<span class="${c}">${m}</span>`);
function bubble(t, who = "sys") {
  const d = document.createElement("div");
  d.className = `msg ${who}`; d.textContent = t; chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// ---------- Supabase: compartments + mixes ----------
async function loadDevice() {
  const { data } = await sb.from("devices").select("slots").eq("device_id", CONFIG.DEVICE_ID).maybeSingle();
  slots = (data && data.slots) || {}; renderSlots();
}
function renderSlots() {
  const e = Object.entries(slots).sort((a, b) => +a[0] - +b[0]);
  slotsEl.innerHTML = e.length
    ? e.map(([s, n]) => `<button class="slot" data-slot="${s}"><b>${n}</b><small>compartment ${s} · tap</small></button>`).join("")
    : `<div class="slot"><small>no compartments set</small></div>`;
  slotsEl.querySelectorAll(".slot[data-slot]").forEach((el) =>
    (el.onclick = () => dispense([{ slot: +el.dataset.slot, dose_units: 1 }]).catch((e) => status(e.message, "err"))));
}
async function loadRecipes() {
  const { data } = await sb.from("recipes").select("*").order("name");
  recipes = data || []; renderRecipes();
}
function renderRecipes() {
  recipesWrap.hidden = recipes.length === 0;
  recipesEl.innerHTML = recipes.map((r) =>
    `<button class="slot" data-recipe="${r.id}"><b>${r.name}</b><small>${(r.steps||[]).length} spices · tap</small></button>`).join("");
  recipesEl.querySelectorAll(".slot[data-recipe]").forEach((el) =>
    (el.onclick = () => { const r = recipes.find((x) => x.id === el.dataset.recipe);
                          if (r) { bubble(`Making "${r.name}"`); dispense(r.steps).catch((e) => status(e.message, "err")); } }));
}
async function saveCompartments(map) {
  const merged = { ...slots };
  for (const [k, v] of Object.entries(map || {})) {
    const n = String(parseInt(k, 10));
    if (+n >= 1 && +n <= 6 && v && String(v).trim()) merged[n] = String(v).trim();
  }
  const { error } = await sb.from("devices").upsert({ device_id: CONFIG.DEVICE_ID, slots: merged }, { onConflict: "device_id" });
  if (error) throw new Error(error.message);
  slots = merged; renderSlots();
  bubble(`Compartments: ${Object.entries(merged).sort((a, b) => +a[0] - +b[0]).map(([n, s]) => `${n}=${s}`).join(", ")}`);
}
async function saveMix(name, steps) {
  if (!name || !Array.isArray(steps) || !steps.length) throw new Error("empty mix");
  const { error } = await sb.from("recipes").insert([{ name, steps }]);
  if (error) throw new Error(error.message);
  bubble(`Saved mix "${name}" 📖`); await loadRecipes();
}
function getState() {
  return { compartments: slots, mixes: recipes.map((r) => ({ name: r.name, steps: r.steps })) };
}

// ---------- BLE ----------
async function connectBLE() {
  try {
    status("initialising Bluetooth…");
    await BleClient.initialize({ androidNeverForLocation: true });
    const device = await BleClient.requestDevice({ services: [CONFIG.BLE_SERVICE] });
    await BleClient.connect(device.deviceId, onDisconnect);
    deviceId = device.deviceId;
    await BleClient.startNotifications(deviceId, CONFIG.BLE_SERVICE, CONFIG.BLE_STATUS, onStatus);
    bleBtn.textContent = "🟢 Dispenser"; bleBtn.classList.add("connected");
    status("dispenser connected", "ok"); bubble("Dispenser connected over Bluetooth ✅");
  } catch (e) { status("BLE: " + (e.message || e), "err"); }
}
function onDisconnect() {
  deviceId = null; bleBtn.textContent = "🔗 Connect"; bleBtn.classList.remove("connected");
  status("dispenser disconnected", "err");
}
function onStatus(value) {
  let s; try { s = JSON.parse(dataViewToText(value)); } catch { return; }
  const spice = slots[s.slot] ?? (s.slot != null ? `compartment ${s.slot}` : "");
  if (s.status === "running") status(`dispensing ${spice}…`);
  else if (s.status === "done") status("✓ done", "ok");
  else if (s.status === "error") status("✗ " + (s.msg || "error"), "err");
}
bleBtn.onclick = () => (deviceId ? null : connectBLE());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// dispense over BLE; if no device is connected, SIMULATE so the app is fully
// testable standalone (e.g. driven over adb) without hardware.
async function dispense(plan) {
  const steps = (plan || []).filter((p) => p && p.slot != null && p.dose_units > 0)
    .map((p) => ({ slot: +p.slot, dose_units: +p.dose_units }));
  if (!steps.length) return;
  const sim = !deviceId;
  bubble(`Dispensing${sim ? " (simulated)" : ""}: ${steps.map((s) => `${slots[s.slot] || "compartment " + s.slot} ×${s.dose_units}`).join(", ")}`);
  if (sim) {
    for (const s of steps) { status(`dispensing ${slots[s.slot] || "compartment " + s.slot}… (sim)`); await sleep(600); }
    status("✓ done (simulated)", "ok");
    return;
  }
  await BleClient.write(deviceId, CONFIG.BLE_SERVICE, CONFIG.BLE_CMD,
    textToDataView(JSON.stringify(steps.length === 1 ? steps[0] : steps)));
}

// ---------- agent (DeepInfra + tool calling) ----------
const ctx = { dispense, saveCompartments, saveMix, getState };
function systemPrompt() {
  const st = getState();
  const comp = Object.entries(st.compartments).sort((a, b) => +a[0] - +b[0]).map(([n, s]) => `${n}=${s}`).join(", ") || "all empty";
  const mixes = st.mixes.length ? st.mixes.map((m) => m.name).join(", ") : "none yet";
  return `You are the friendly voice and the brain of a smart spice dispenser with 6 compartments (1-6).
Talk like a warm, concise friend (your words are read aloud). Compartments: ${comp}. Saved mixes: ${mixes}.
A dose_unit is one pinch (servo sweep); there is no scale, so think in relative pinch counts.

You are a knowledgeable cook. When someone names a dish and the flavor they want (e.g. "chicken
curry, smoky and a little spicy"), REASON about it and PROPOSE a concrete mix:
- Pick the spices to combine ONLY from what is actually loaded above, choosing what genuinely fits
  that cuisine and flavor goal. If a classic spice for the dish isn't loaded, say so and suggest the
  closest loaded substitute.
- Decide pinch counts per spice that reflect the balance you want (e.g. more paprika for smoky, a
  pinch of chili for heat), and say the proposed blend out loud in one short sentence with a quick
  reason ("paprika for smoke, a little cumin for warmth, one chili for the kick").
- Then ask the cook to confirm or tweak. On confirmation, call dispense with that plan, and offer to
  save_mix it under a name.

Compartment setup is ON-REQUEST ONLY: call set_compartments ONLY when the cook explicitly tells you
what spice goes in a compartment ("put paprika in 1"). NEVER prompt them to set up, re-confirm, or
re-load compartments, and once spices are loaded don't bring setup up again — just cook with what's there.

Use your other tools to act: dispense to run the motors; save_mix to remember a blend; get_state to check.
Ask ONE short clarifying question at a time only when you truly need it (dish? flavor? how spicy?).
Don't over-ask — once you know the dish and the vibe, propose. Only dispense compartments that actually
contain a spice.`;
}
// prefer OpenAI (cleaner tool-calling) when its key is baked in, else DeepInfra
function llmTarget() {
  return CONFIG.OPENAI_KEY
    ? { url: `${CONFIG.OPENAI_BASE}/chat/completions`, key: CONFIG.OPENAI_KEY, model: CONFIG.OPENAI_MODEL }
    : { url: `${CONFIG.DEEPINFRA_BASE}/chat/completions`, key: LS.diKey, model: CONFIG.LLM_MODEL };
}
function hasLLMKey() { return !!(CONFIG.OPENAI_KEY || LS.diKey); }
async function llmStep() {
  const t = llmTarget();
  const r = await fetch(t.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${t.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: t.model, temperature: 0.4,
      messages: [{ role: "system", content: systemPrompt() }, ...messages],
      tools: TOOL_DEFS, tool_choice: "auto",
    }),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return (await r.json()).choices?.[0]?.message || { content: "…" };
}
async function agentTurn(userText) {
  if (busy) return; busy = true;
  bubble(userText, "user"); messages.push({ role: "user", content: userText }); status("thinking…");
  try {
    for (let round = 0; round < 5; round++) {
      const msg = await llmStep();
      messages.push(msg);
      if (msg.tool_calls && msg.tool_calls.length) {
        for (const tc of msg.tool_calls) {
          let args = {}; try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
          const result = await runTool(tc.function.name, args, ctx);
          messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(result) });
        }
        continue; // let the model speak after seeing tool results
      }
      const say = (msg.content || "").trim();
      if (say) { bubble(say, "bot"); await speak(say); }
      break;
    }
    status("");
  } catch (e) { status(e.message, "err"); bubble("⚠️ " + e.message); }
  finally { busy = false; }
}
async function speak(text) { if (LS.tts) { try { await TextToSpeech.speak({ text, lang: "en-US", rate: 1.0 }); } catch {} } }

// ---------- continuous native speech ----------
async function startConversation() {
  if (!hasLLMKey()) { openSettings(); status("add an API key for voice", "err"); return; }
  try {
    const { available } = await SpeechRecognition.available();
    if (!available) { status("speech recognition unavailable", "err"); return; }
    const perm = await SpeechRecognition.requestPermissions();
    if (perm.speechRecognition !== "granted") { status("microphone permission denied", "err"); return; }
  } catch (e) { status("speech init: " + (e.message || e), "err"); return; }
  await SpeechRecognition.removeAllListeners();
  await SpeechRecognition.addListener("partialResults", (d) => { if (d.matches && d.matches[0]) interimEl.textContent = d.matches[0]; });
  listening = true; micBtn.textContent = "⏹ Stop listening"; micBtn.classList.add("listening");
  listenLoop();
}
async function listenLoop() {
  while (listening) {
    try {
      if (!busy) status("listening — just talk", "");
      const res = await SpeechRecognition.start({ language: "en-US", maxResults: 1, partialResults: true, popup: false });
      interimEl.textContent = "";
      const text = res?.matches?.[0];
      if (text && listening) await agentTurn(text);
    } catch (_) { /* no-match / timeout — keep looping */ }
  }
}
async function stopConversation() {
  listening = false;
  try { await SpeechRecognition.stop(); } catch {}
  try { await SpeechRecognition.removeAllListeners(); } catch {}
  micBtn.textContent = "🎙️ Start talking"; micBtn.classList.remove("listening");
  interimEl.textContent = ""; status("");
}
// ---------- realtime voice (OpenAI speech-to-speech) ----------
let rt = null;
async function startRealtimeVoice() {
  if (!CONFIG.OPENAI_KEY) { status("OpenAI key needed for realtime", "err"); return; }
  listening = true; micBtn.textContent = "⏹ Stop"; micBtn.classList.add("listening");
  try {
    rt = await startRealtime({
      instructions: systemPrompt(),
      tools: realtimeTools(),
      onToolCall: (name, args) => runTool(name, args, ctx),
      onUserText: (t) => bubble(t, "user"),
      onBotText: (t) => bubble(t, "bot"),
      log: (kind, text) => {
        if (kind === "err") { status(text, "err"); bubble("⚠️ " + text); }
        else if (kind === "tool") bubble("🔧 " + text);
        else status(text, "ok");
      },
    });
  } catch (e) { status("realtime: " + (e.message || e), "err"); bubble("⚠️ " + (e.message || e)); stopRealtimeVoice(); }
}
function stopRealtimeVoice() {
  try { rt && rt.stop(); } catch {}
  rt = null; listening = false; micBtn.textContent = "🎙️ Start talking"; micBtn.classList.remove("listening"); status("");
}

micBtn.onclick = () => {
  if (listening) return rt ? stopRealtimeVoice() : stopConversation();
  return LS.voiceMode === "realtime" ? startRealtimeVoice() : startConversation();
};

// ---------- motor control buttons ----------
function openMotors() {
  const grid = $("#motorBtns");
  grid.innerHTML = Array.from({ length: 6 }, (_, i) => {
    const n = i + 1, name = slots[n] ? `<b>${slots[n]}</b>` : `<b>#${n}</b>`;
    return `<button type="button" data-comp="${n}">${name}<small>compartment ${n}</small></button>`;
  }).join("");
  grid.querySelectorAll("button[data-comp]").forEach((b) => {
    b.onclick = (e) => { e.preventDefault();
      const dose = Math.max(1, +$("#motorDose").value || 1);
      dispense([{ slot: +b.dataset.comp, dose_units: dose }]).catch((er) => status(er.message, "err")); };
  });
  $("#motors").showModal();
}
$("#motorsBtn").onclick = openMotors;

// ---------- init / setup (compartments 1–6) ----------
function openInit() {
  $("#initRows").innerHTML = Array.from({ length: 6 }, (_, i) => {
    const n = i + 1;
    return `<label>Compartment ${n}<input type="text" data-comp="${n}" autocomplete="off" autocapitalize="off"
      value="${(slots[n] || "").replace(/"/g, "&quot;")}" placeholder="e.g. paprika" /></label>`;
  }).join("");
  $("#init").showModal();
}
async function saveInit() {
  const map = {};
  $("#initRows").querySelectorAll("input[data-comp]").forEach((el) => { if (el.value.trim()) map[el.dataset.comp] = el.value.trim(); });
  try { slots = {}; await saveCompartments(map); status("compartments saved", "ok"); }
  catch (e) { status("save: " + e.message, "err"); }
}
$("#initBtn").onclick = openInit;
$("#saveInit").onclick = saveInit;

// ---------- settings ----------
function openSettings() {
  $("#diKey").value = LS.diKey; $("#ttsOn").checked = LS.tts; $("#voiceMode").value = LS.voiceMode;
  $("#settings").showModal();
}
$("#settingsBtn").onclick = openSettings;
$("#saveSettings").onclick = () => { LS.diKey = $("#diKey").value.trim(); LS.tts = $("#ttsOn").checked; LS.voiceMode = $("#voiceMode").value; };

// ---------- boot ----------
(async function init() {
  bubble("Connect the dispenser, set up compartments, then talk to me 🎙️");
  await loadDevice(); await loadRecipes();
  if (!Object.keys(slots).length) { bubble("First time? Set up your compartments 🧂"); openInit(); }
})();

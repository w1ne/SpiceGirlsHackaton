import { createClient } from "@supabase/supabase-js";
import { BleClient, textToDataView, dataViewToText } from "@capacitor-community/bluetooth-le";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { TextToSpeech } from "@capacitor-community/text-to-speech";
import { CONFIG } from "../config.js";
import { TOOL_DEFS, runTool, realtimeTools } from "./tools.js";
import { startRealtime } from "./realtime.js";
import { PERSONAS, DEFAULT_PERSONA_ID, getPersona, personaSystemPrompt } from "./personas.js";

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
let slots = {}, recipes = [], messages = [];
let prefs = {}, allergens = [];
let deviceId = null, listening = false, busy = false, connecting = false, notifyOk = false;

const LS = {
  get diKey() { return localStorage.getItem("di_key") || ""; },
  set diKey(v) { localStorage.setItem("di_key", v); },
  get tts() { return localStorage.getItem("tts") !== "0"; },
  set tts(v) { localStorage.setItem("tts", v ? "1" : "0"); },
  // "realtime" (OpenAI speech-to-speech) or "classic" (turn-based STT→LLM→TTS)
  get voiceMode() { return localStorage.getItem("voice_mode") || "realtime"; },
  set voiceMode(v) { localStorage.setItem("voice_mode", v); },
  // Last dispenser we connected to (Android deviceId == MAC). Lets us reconnect
  // WITHOUT scanning — Android throttles an app to zero results after a few
  // scans, so skipping the scan is what makes reconnect reliable.
  get deviceId() { return localStorage.getItem("ble_device_id") || CONFIG.BLE_DEVICE_ID || ""; },
  set deviceId(v) { v ? localStorage.setItem("ble_device_id", v) : localStorage.removeItem("ble_device_id"); },
  // Active character persona (personality + voice).
  get persona() { return localStorage.getItem("persona") || DEFAULT_PERSONA_ID; },
  set persona(v) { localStorage.setItem("persona", v); },
};
const activePersona = () => getPersona(LS.persona);

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
    ? `<div class="section-head">🧂 Your spices <small class="muted">tap to dispense one pinch</small></div>
       <div class="slots">${e.map(([s, n]) => `<button class="slot" data-slot="${s}"><b>${n}</b><small>#${s} · tap</small></button>`).join("")}</div>`
    : `<button class="empty-cta" id="emptyInit">🧂 Set up your spice compartments<small>tell the dispenser what's loaded to get started</small></button>`;
  slotsEl.querySelectorAll(".slot[data-slot]").forEach((el) =>
    (el.onclick = () => dispense([{ slot: +el.dataset.slot, dose_units: 1 }]).catch((e) => status(e.message, "err"))));
  const cta = slotsEl.querySelector("#emptyInit");
  if (cta) cta.onclick = openInit;
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
  return {
    compartments: slots,
    mixes: recipes.map((r) => ({ name: r.name, steps: r.steps })),
    preferences: prefs,
    allergens,
  };
}

// ---------- preferences + allergens (#4 personalization) ----------
async function loadPreferences() {
  const { data } = await sb.from("preferences").select("key,value").eq("user_id", "shared");
  prefs = {}; allergens = [];
  for (const row of data || []) {
    if (row.key === "allergens") allergens = String(row.value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    else prefs[row.key] = row.value;
  }
}
async function setPreference(key, value) {
  const { error } = await sb.from("preferences").upsert({ user_id: "shared", key, value }, { onConflict: "user_id,key" });
  if (error) throw new Error(error.message);
  prefs[key] = value; bubble(`Noted: ${key} = ${value} 📝`);
}
async function setAllergens(spices) {
  const list = [...new Set((spices || []).map((s) => String(s).toLowerCase().trim()).filter(Boolean))];
  const { error } = await sb.from("preferences").upsert({ user_id: "shared", key: "allergens", value: list.join(",") }, { onConflict: "user_id,key" });
  if (error) throw new Error(error.message);
  allergens = list; bubble(list.length ? `⚠️ Allergens set: ${list.join(", ")} — I'll never dispense these.` : "Allergens cleared.");
}

// ---------- BLE ----------
// Find the dispenser with a manual LE scan and match CLIENT-SIDE on the advertised
// service UUID (and name) from the scan record. We deliberately avoid:
//   • requestDevice({namePrefix}) — it matches BluetoothDevice.getName(), which
//     Android often returns null for mid-scan (the name is in the scan record, not
//     the device cache), so discovery is racy and usually fails on Pixel.
//   • a hardware service-UUID ScanFilter — flaky for 128-bit UUIDs on some phones.
// requestLEScan (unfiltered) hands us result.uuids / result.localName parsed from
// the scan record, which is reliable.
// Pull the advertised local name (AD types 0x08 shortened / 0x09 complete) out of
// the raw scan-record bytes. The plugin's result.localName comes from
// BluetoothDevice.getName(), which is null mid-scan; the raw advertisement always
// carries our name in the primary packet, so this is the reliable source.
function advLocalName(raw) {
  try {
    let bytes;
    if (raw && raw.buffer) bytes = new Uint8Array(raw.buffer);            // DataView
    else if (typeof raw === "string") bytes = Uint8Array.from(raw.match(/.{1,2}/g).map((h) => parseInt(h, 16)));
    else return "";
    for (let i = 0; i < bytes.length; ) {
      const len = bytes[i];
      if (!len) break;
      const type = bytes[i + 1];
      if (type === 0x09 || type === 0x08) return new TextDecoder().decode(bytes.slice(i + 2, i + 1 + len));
      i += 1 + len;
    }
  } catch {}
  return "";
}

function scanForDispenser(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let done = false, seen = 0;
    const names = new Set();
    const finish = async (fn, arg) => {
      if (done) return; done = true;
      try { await BleClient.stopLEScan(); } catch {}
      fn(arg);
    };
    const want = CONFIG.BLE_SERVICE.toLowerCase();
    const timer = setTimeout(() =>
      finish(reject, new Error(`dispenser not found (saw ${seen} adverts; names: ${[...names].slice(0, 6).join(", ") || "none"})`)), timeoutMs);
    BleClient.requestLEScan({ allowDuplicates: true }, (result) => {
      seen++;
      const name = advLocalName(result.rawAdvertisement) || result.localName || result.device?.name || "";
      if (name) names.add(name);
      const hasUuid = (result.uuids || []).some((u) => String(u).toLowerCase() === want);
      const hasName = String(name).startsWith("SpiceGirls");
      if (hasUuid || hasName) { clearTimeout(timer); finish(resolve, result.device); }
    }).catch((e) => { clearTimeout(timer); if (!done) { done = true; reject(e); } });
  });
}

async function connectBLE() {
  if (deviceId || connecting) return;
  connecting = true;
  try {
    status("initialising Bluetooth…");
    await BleClient.initialize({ androidNeverForLocation: true });
    let lastErr;
    // FAST PATH: reconnect straight to the address we used last time — no scan,
    // so Android's scan throttle can never block us. This is the reliable path
    // once we've connected once.
    const known = LS.deviceId;
    if (known) {
      try {
        status("connecting to dispenser…");
        await BleClient.connect(known, onDisconnect);
        deviceId = known;
      } catch (e) { lastErr = e; try { await BleClient.disconnect(known); } catch {} }
    }
    // FALLBACK: only scan if we have no remembered device or the direct connect
    // failed. One scan, then connect — keep scan count low to avoid throttling.
    for (let attempt = 1; attempt <= 2 && !deviceId; attempt++) {
      let device;
      try {
        status(attempt === 1 ? "scanning for dispenser…" : `scanning… (try ${attempt})`);
        device = await scanForDispenser();
        await BleClient.connect(device.deviceId, onDisconnect);
        deviceId = device.deviceId;
      } catch (e) {
        lastErr = e;
        try { if (device) await BleClient.disconnect(device.deviceId); } catch {}
        await sleep(900);
      }
    }
    if (!deviceId) throw lastErr || new Error("could not connect");
    LS.deviceId = deviceId; // remember for the throttle-proof fast path next time
    // Status notifications are best-effort: the firmware's status characteristic
    // may lack a CCCD (subscribe → NotSupported). Dispensing works regardless, so
    // never let a notify failure tear down a good connection.
    try {
      await BleClient.startNotifications(deviceId, CONFIG.BLE_SERVICE, CONFIG.BLE_STATUS, onStatus);
      notifyOk = true;
    } catch (e) { notifyOk = false; console.warn("status notifications unavailable:", e?.message || e); }
    bleBtn.textContent = "🟢 Dispenser"; bleBtn.classList.add("connected");
    status("dispenser connected", "ok"); bubble("Dispenser connected over Bluetooth ✅");
  } catch (e) {
    status("BLE: " + (e.message || e), "err");
  } finally {
    connecting = false;
  }
}
function onDisconnect() {
  deviceId = null; notifyOk = false; bleBtn.textContent = "🔗 Connect"; bleBtn.classList.remove("connected");
  status("dispenser disconnected — reconnecting…", "err");
  // Self-heal: the ESP drops the link if it resets (e.g. re-powered, or USB
  // re-enumerated). Auto-reconnect so dispenses keep reaching the motors instead
  // of silently simulating. The fast path (connect by address) makes this quick.
  if (!listening) setTimeout(() => { if (!deviceId) connectBLE().catch(() => {}); }, 1500);
}
let statusWaiters = [];
function onStatus(value) {
  statusWaiters.splice(0).forEach((r) => r()); // a pending dispense heard the firmware reply
  let s; try { s = JSON.parse(dataViewToText(value)); } catch { return; }
  const spice = slots[s.slot] ?? (s.slot != null ? `compartment ${s.slot}` : "");
  if (s.status === "running") status(`dispensing ${spice}…`);
  else if (s.status === "done") status("✓ done", "ok");
  else if (s.status === "error") status("✗ " + (s.msg || "error"), "err");
}
// Resolve when the firmware sends ANY status notification (proof of life), else
// reject after ms. Used to detect a dead link that GATT still reports "connected".
function nextStatus(ms) {
  return new Promise((resolve, reject) => {
    statusWaiters.push(resolve);
    setTimeout(() => {
      const i = statusWaiters.indexOf(resolve);
      if (i >= 0) { statusWaiters.splice(i, 1); reject(new Error("no reply")); }
    }, ms);
  });
}
// The app's deviceId can be STALE — Android may not fire onDisconnect when the
// ESP resets, so we'd think we're connected while the firmware is advertising
// (blue LED). Verify against the OS's real connection list; reconnect if stale.
async function ensureLive() {
  if (deviceId) {
    try {
      const connected = await BleClient.getConnectedDevices([CONFIG.BLE_SERVICE]);
      if (connected.some((d) => d.deviceId === deviceId)) return true;
      // OS says we are NOT actually connected — drop the stale belief.
      deviceId = null; bleBtn.textContent = "🔗 Connect"; bleBtn.classList.remove("connected"); notifyOk = false;
    } catch { return true; } // can't check → assume fine, don't disrupt a good link
  }
  status("reconnecting to dispenser…");
  await connectBLE().catch(() => {});
  return !!deviceId;
}
bleBtn.onclick = () => (deviceId ? null : connectBLE());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// dispense over BLE; if no device is connected, SIMULATE so the app is fully
// testable standalone (e.g. driven over adb) without hardware.
async function dispense(plan) {
  const steps = (plan || []).filter((p) => p && p.slot != null && p.dose_units > 0)
    .map((p) => ({ slot: +p.slot, dose_units: +p.dose_units }));
  if (!steps.length) return;
  // Verify we're REALLY connected (not a stale handle) before claiming to dispense.
  await ensureLive();
  const sim = !deviceId;
  bubble(`Dispensing${sim ? " (simulated)" : ""}: ${steps.map((s) => `${slots[s.slot] || "compartment " + s.slot} ×${s.dose_units}`).join(", ")}`);
  if (sim) {
    for (const s of steps) { status(`dispensing ${slots[s.slot] || "compartment " + s.slot}… (sim)`); await sleep(600); }
    status("⚠️ simulated — dispenser not connected", "err");
    return;
  }
  // Send each step as its own SHORT write. The BLE default ATT payload is 20
  // bytes, so {"slot":1,"dose_units":1} (25B) gets truncated → "bad json". Short
  // keys ({"s":1,"d":1} = 13B) fit, and one write per step keeps every message
  // under 20B no matter how many spices are in the mix. Sequential awaits avoid
  // overlapping writes corrupting each other.
  for (const s of steps) {
    const reply = notifyOk ? nextStatus(4000) : null; // arm a proof-of-life wait before writing
    await BleClient.write(deviceId, CONFIG.BLE_SERVICE, CONFIG.BLE_CMD,
      textToDataView(JSON.stringify({ s: s.slot, d: s.dose_units })));
    if (reply) {
      // The firmware ALWAYS notifies "running"/"done". Silence = the link is dead
      // even though GATT still says connected (e.g. the ESP reset). Don't lie
      // about success — mark disconnected and surface it.
      try { await reply; } catch {
        onDisconnect();
        throw new Error("dispenser not responding — reconnecting, try again");
      }
    }
    await sleep(1200); // let the revolver+shutter finish one dose before the next
  }
}

// ---------- agent (DeepInfra + tool calling) ----------
const ctx = { dispense, saveCompartments, saveMix, getState, setPreference, setAllergens };
function systemPrompt() {
  const st = getState();
  const comp = Object.entries(st.compartments).sort((a, b) => +a[0] - +b[0]).map(([n, s]) => `compartment ${n} = ${s}`).join(", ") || "all empty";
  const mixes = st.mixes.length ? st.mixes.map((m) => m.name).join(", ") : "none yet";
  const prefLine = Object.entries(st.preferences || {}).map(([k, v]) => `${k}: ${v}`).join(", ") || "none yet";
  const allergyLine = (st.allergens || []).length ? st.allergens.join(", ") : "none";
  const base = `You are the brain of a smart spice dispenser, 6 compartments (1-6).
Compartments: ${comp}. Saved mixes: ${mixes}. Preferences: ${prefLine}. Allergies (NEVER dispense): ${allergyLine}.
A dose_unit is one pinch. Your words are read aloud, so be MINIMAL.

The compartment list above is COMPLETE and AUTHORITATIVE. NEVER ask which compartment a spice is in —
look it up in that list yourself. If the cook names a spice that's in the list, you already know its
compartment; just use it. Only say a spice is unavailable if it's truly not in the list.

ACT, DON'T CHATTER. When the cook's intent is clear, call dispense IMMEDIATELY — do NOT ask for
confirmation, do NOT read the plan back first. Just dispense, then say what you dispensed in ONE short
sentence ("Two pinches of paprika, one chili — done."). Decide pinch counts yourself; honor preferences
and never dispense an allergen.

STOP AFTER DISPENSING. Once you've dispensed and said the one-line result, you are DONE — go silent. Do
NOT ask "anything else?", do NOT suggest more spices, do NOT keep the conversation going. Wait quietly;
only speak again when the cook gives a new instruction.

ONLY RESPOND WHEN SPOKEN TO ABOUT SPICES. You are listening in a kitchen and will overhear unrelated
talk. If what you hear is NOT a request to dispense or a cooking question directed at you, say NOTHING
at all — do not react, do not comment, stay completely silent. Never join general conversation.

Only ask a question if you genuinely can't act (dish unknown, or no fitting spice is loaded). One short
clarifying question, never a checklist. Never re-confirm, never re-read the plan, never offer to save
unless asked. Pick spices ONLY from what's loaded above. set_preference on a lasting taste, set_allergens
on an allergy, set_compartments ONLY when told what goes where — never prompt for setup.`;
  // Layer the active character's personality on top of the functional rules.
  return personaSystemPrompt(activePersona(), base);
}
// Local-dev fallback target (proxy off): DeepInfra with a dev-entered key.
function llmTarget() {
  return { url: `${CONFIG.DEEPINFRA_BASE}/chat/completions`, key: LS.diKey, model: CONFIG.LLM_MODEL };
}
// In proxy mode the key lives server-side, so no client key is needed.
function hasLLMKey() { return CONFIG.PROXY || !!LS.diKey; }
async function llmStep() {
  const payload = {
    temperature: 0.4,
    messages: [{ role: "system", content: systemPrompt() }, ...messages],
    tools: TOOL_DEFS, tool_choice: "auto",
  };
  let url, key;
  if (CONFIG.PROXY) {
    url = `${CONFIG.FN_BASE}/llm-proxy`; key = CONFIG.SUPABASE_ANON_KEY; // server holds the provider key
  } else {
    const t = llmTarget(); url = t.url; key = t.key; payload.model = t.model;
  }
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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
// Speak a reply with the device's built-in TTS (used by classic + typed turns).
// The fluent, in-character voice comes from realtime mode (OpenAI), which
// generates its own audio; this is just the turn-based fallback.
async function speak(text) {
  if (!text || !LS.tts) return;
  try { await TextToSpeech.speak({ text, lang: "en-US", rate: 1.0 }); } catch {}
}

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
      // partialResults:false makes start() BLOCK for the whole listen (~5s) until
      // a final result, so the loop paces itself — no spin. We keep the gap
      // between listens tiny so the mic is open almost continuously and doesn't
      // miss speech that lands between windows.
      const res = await SpeechRecognition.start({ language: "en-US", maxResults: 1, partialResults: false, popup: false });
      if (!listening) break; // Stop was tapped while we were listening
      interimEl.textContent = "";
      const text = res?.matches?.[0];
      if (text) await agentTurn(text);
      await sleep(120);
    } catch (_) {
      // start() rejects on "No match" (silence) or "busy". Bail out fast if Stop
      // was tapped; otherwise a short backoff (NOT a spin — start() already
      // blocked) then listen again.
      if (!listening) break;
      try { await SpeechRecognition.stop(); } catch {}
      await sleep(250);
    }
  }
}
async function stopConversation() {
  // Update the UI FIRST, synchronously — so the tap visibly stops it even if the
  // native stop()/removeAllListeners() calls below are slow or hang.
  listening = false;
  micBtn.textContent = "🎙️ Start talking"; micBtn.classList.remove("listening");
  interimEl.textContent = ""; status("");
  try { await SpeechRecognition.stop(); } catch {}
  try { await SpeechRecognition.removeAllListeners(); } catch {}
}
// ---------- realtime voice (OpenAI speech-to-speech) ----------
let rt = null;
async function startRealtimeVoice() {
  if (!CONFIG.PROXY) { status("realtime needs proxy mode (edge functions)", "err"); return; }
  // Make sure the dispenser is connected BEFORE the conversation starts, so a
  // dispense actually runs the motors instead of silently simulating.
  if (!deviceId) { bubble("Connecting to the dispenser first…"); await connectBLE().catch(() => {}); }
  if (!deviceId) bubble("⚠️ Dispenser not connected — I'll talk you through it but can't run the motors yet.");
  listening = true; micBtn.textContent = "⏹ Stop"; micBtn.classList.add("listening");
  try {
    rt = await startRealtime({
      instructions: systemPrompt(),
      voice: activePersona().rtVoice, // OpenAI preset for the active character
      tools: realtimeTools(),
      onToolCall: (name, args) => runTool(name, args, ctx),
      onUserText: (t) => bubble(t, "user"),
      onBotText: (t) => bubble(t, "bot"),
      onIdle: () => { bubble("Paused after a quiet minute — tap to talk again 💤"); stopRealtimeVoice(); },
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

// Typed commands — a reliable input path that doesn't depend on speech
// recognition. Runs the same agent turn (LLM + tools + device-TTS reply).
$("#typeForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const el = $("#typeInput");
  const text = el.value.trim();
  if (!text || busy) return;
  el.value = "";
  if (!hasLLMKey()) { openSettings(); status("add an API key for voice", "err"); return; }
  agentTurn(text);
});

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
  $("#appVer").textContent = "v" + CONFIG.APP_VERSION;
  $("#settings").showModal();
}
$("#settingsBtn").onclick = openSettings;
$("#saveSettings").onclick = () => { LS.diKey = $("#diKey").value.trim(); LS.tts = $("#ttsOn").checked; LS.voiceMode = $("#voiceMode").value; };

// ---------- persona picker ----------
function syncPersonaChip() {
  const p = activePersona();
  $("#personaBtn").textContent = p.emoji;
  $("#personaBtn").title = `Character: ${p.name}`;
}
function selectPersona(id) {
  LS.persona = id;
  // Every character uses the fluent realtime voice (OpenAI speech-to-speech)
  // with its own preset voice; the model reads the personality from the prompt.
  LS.voiceMode = "realtime";
  syncPersonaChip();
  const p = activePersona();
  bubble(`${p.emoji} ${p.name} is now your spice guide.`, "bot");
  renderPersonaList();
}
function renderPersonaList() {
  const cur = LS.persona;
  $("#personaList").innerHTML = PERSONAS.map((p) =>
    `<button type="button" class="persona${p.id === cur ? " on" : ""}" data-persona="${p.id}">
       <span class="pemoji">${p.emoji}</span>
       <span class="pmeta"><b>${p.name}</b><small>${p.blurb}</small></span>
     </button>`).join("");
  $("#personaList").querySelectorAll("button[data-persona]").forEach((el) =>
    (el.onclick = () => selectPersona(el.dataset.persona)));
}
function openPersonas() { renderPersonaList(); $("#personas").showModal(); }
$("#personaBtn").onclick = openPersonas;

// ---------- boot ----------
(async function init() {
  syncPersonaChip();
  bubble("Setting up… connecting to your dispenser 🎙️");
  await loadDevice(); await loadRecipes(); await loadPreferences();
  if (!Object.keys(slots).length) { bubble("First time? Set up your compartments 🧂"); openInit(); }
  // Auto-connect on launch so the cook never has to tap Connect; silent if the
  // dispenser isn't powered/in range (the manual button stays as a fallback).
  connectBLE().catch(() => {});
})();

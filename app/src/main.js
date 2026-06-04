import { createClient } from "@supabase/supabase-js";
import { BleClient, textToDataView, dataViewToText } from "@capacitor-community/bluetooth-le";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { TextToSpeech } from "@capacitor-community/text-to-speech";
import { CONFIG } from "../config.js";

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
let slots = {}, recipes = [], messages = [];
let deviceId = null;        // connected BLE device
let listening = false, busy = false;

const LS = {
  // baked-in key from build (.env.local) by default; settings can override
  get diKey() { return localStorage.getItem("di_key") || CONFIG.DEEPINFRA_KEY || ""; },
  set diKey(v) { localStorage.setItem("di_key", v); },
  get tts() { return localStorage.getItem("tts") !== "0"; },
  set tts(v) { localStorage.setItem("tts", v ? "1" : "0"); },
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

// ---------- Supabase: slots + recipes ----------
async function loadDevice() {
  const { data } = await sb.from("devices").select("slots").eq("device_id", CONFIG.DEVICE_ID).maybeSingle();
  slots = (data && data.slots) || {}; renderSlots();
}
function renderSlots() {
  const e = Object.entries(slots).sort((a, b) => +a[0] - +b[0]);
  slotsEl.innerHTML = e.length
    ? e.map(([s, n]) => `<button class="slot" data-slot="${s}"><b>${n}</b><small>slot ${s} · tap</small></button>`).join("")
    : `<div class="slot"><small>no slots</small></div>`;
  slotsEl.querySelectorAll(".slot[data-slot]").forEach((el) =>
    (el.onclick = () => dispense([{ slot: +el.dataset.slot, dose_units: 1 }])));
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
                          if (r) { bubble(`Making "${r.name}"`); dispense(r.steps); } }));
}
// merge {compartment: spice} into the device config and persist (voice + manual)
async function saveCompartments(map) {
  const merged = { ...slots };
  for (const [k, v] of Object.entries(map || {})) {
    const n = String(parseInt(k, 10));
    if (n >= "1" && n <= "6" && v && String(v).trim()) merged[n] = String(v).trim();
  }
  const { error } = await sb.from("devices")
    .upsert({ device_id: CONFIG.DEVICE_ID, slots: merged }, { onConflict: "device_id" });
  if (error) { status("save compartments: " + error.message, "err"); return; }
  slots = merged; renderSlots();
  bubble(`Compartments: ${Object.entries(merged).sort((a, b) => +a[0] - +b[0]).map(([n, s]) => `${n}=${s}`).join(", ")}`);
}
async function saveRecipe(name, steps) {
  if (!name || !Array.isArray(steps) || !steps.length) return;
  const { error } = await sb.from("recipes").insert([{ name, steps }]);
  if (!error) { bubble(`Saved recipe "${name}" 📖`); await loadRecipes(); }
}

// ---------- native BLE ----------
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
  const spice = slots[s.slot] ?? (s.slot != null ? `slot ${s.slot}` : "");
  if (s.status === "running") status(`dispensing ${spice}…`);
  else if (s.status === "done") status("✓ done", "ok");
  else if (s.status === "error") status("✗ " + (s.msg || "error"), "err");
}
bleBtn.onclick = () => (deviceId ? null : connectBLE());

// ---------- dispense (over BLE) ----------
async function dispense(plan) {
  const steps = (plan || []).filter((p) => p && p.slot != null && p.dose_units > 0)
    .map((p) => ({ slot: +p.slot, dose_units: +p.dose_units }));
  if (!steps.length) return;
  if (!deviceId) { status("connect the dispenser first (🔗)", "err"); return; }
  bubble(`Dispensing: ${steps.map((s) => `${slots[s.slot] || "slot " + s.slot} ×${s.dose_units}`).join(", ")}`);
  try {
    await BleClient.write(deviceId, CONFIG.BLE_SERVICE, CONFIG.BLE_CMD,
      textToDataView(JSON.stringify(steps.length === 1 ? steps[0] : steps)));
  } catch (e) { status("write failed: " + (e.message || e), "err"); }
}

// ---------- DeepInfra LLM ----------
function systemPrompt() {
  const sl = Object.entries(slots).sort((a, b) => +a[0] - +b[0]).map(([s, n]) => `compartment ${s}=${n}`).join(", ") || "all empty";
  const rc = recipes.length ? recipes.map((r) => `"${r.name}": ${JSON.stringify(r.steps)}`).join("; ") : "(none yet)";
  return `You are the voice brain of a smart spice dispenser with 6 compartments (numbered 1-6).
You chat with the cook like a friend. Current compartments: ${sl}. Saved recipes: ${rc}.
A dose_unit is one sweep of the dispense servo (a pinch); there is no scale.

You can do TWO things in conversation:
1) SET UP compartments — when the cook says what spice is in which compartment
   (e.g. "compartment one is paprika", "I put cumin in two and salt in three"),
   return set_compartments mapping the compartment number (1-6) to the spice name.
2) DISPENSE — when the cook wants to cook/make something, ask ONE brief clarifying
   question at a time (dish? servings? how spicy?), then return done=true with a plan.
   Only use compartments that actually contain a spice. If asked to "make <recipe>", use its steps.
You MAY save a good mix via save_recipe.

Speak briefly and warmly (read aloud). ALWAYS reply with ONE JSON object:
{"say":"<spoken>","done":<bool>,"plan":[{"slot":<int>,"dose_units":<int>}],
"set_compartments":null|{"1":"paprika","2":"cumin"},"save_recipe":null|{"name":"...","steps":[...]}}.
While gathering info done=false and plan=[].`;
}
async function askLLM() {
  const r = await fetch(`${CONFIG.DEEPINFRA_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${LS.diKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: CONFIG.LLM_MODEL, temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: systemPrompt() }, ...messages] }),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 100)}`);
  const c = (await r.json()).choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(c); } catch { const m = c.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : { say: c, done: false, plan: [] }; }
}
async function handleUserText(text) {
  if (busy) return; busy = true;
  bubble(text, "user"); messages.push({ role: "user", content: text }); status("thinking…");
  try {
    const res = await askLLM();
    messages.push({ role: "assistant", content: JSON.stringify(res) });
    const say = res.say || "…"; bubble(say, "bot");
    if (res.set_compartments) await saveCompartments(res.set_compartments);
    if (res.save_recipe) await saveRecipe(res.save_recipe.name, res.save_recipe.steps);
    if (res.done && Array.isArray(res.plan) && res.plan.length) await dispense(res.plan);
    await speak(say);
  } catch (e) { status(e.message, "err"); bubble("⚠️ " + e.message); }
  finally { busy = false; }
}

// ---------- native TTS (mic is already stopped while we speak) ----------
async function speak(text) {
  if (!LS.tts) return;
  try { await TextToSpeech.speak({ text, lang: "en-US", rate: 1.0 }); } catch (_) {}
}

// ---------- continuous native speech ----------
async function startConversation() {
  if (!LS.diKey) { openSettings(); status("add your DeepInfra key for voice", "err"); return; }
  try {
    const { available } = await SpeechRecognition.available();
    if (!available) { status("speech recognition unavailable on this device", "err"); return; }
    const perm = await SpeechRecognition.requestPermissions();
    if (perm.speechRecognition !== "granted") { status("microphone permission denied", "err"); return; }
  } catch (e) { status("speech init: " + (e.message || e), "err"); return; }
  await SpeechRecognition.removeAllListeners();
  await SpeechRecognition.addListener("partialResults", (d) => {
    if (d.matches && d.matches[0]) interimEl.textContent = d.matches[0];
  });
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
      if (text && listening) await handleUserText(text);   // mic is idle during this turn
    } catch (_) { /* no-match / timeout — keep looping */ }
  }
}
async function stopConversation() {
  listening = false;
  try { await SpeechRecognition.stop(); } catch (_) {}
  try { await SpeechRecognition.removeAllListeners(); } catch (_) {}
  micBtn.textContent = "🎙️ Start talking"; micBtn.classList.remove("listening");
  interimEl.textContent = ""; status("");
}
micBtn.onclick = () => (listening ? stopConversation() : startConversation());

// ---------- init / setup (compartments 1–6) ----------
const COMPARTMENTS = 6;
function openInit() {
  const rows = $("#initRows");
  rows.innerHTML = Array.from({ length: COMPARTMENTS }, (_, i) => {
    const n = i + 1;
    return `<label>Compartment ${n}
      <input type="text" data-comp="${n}" autocomplete="off" autocapitalize="off"
             value="${(slots[n] || "").replace(/"/g, "&quot;")}" placeholder="e.g. paprika" /></label>`;
  }).join("");
  $("#init").showModal();
}
async function saveInit() {
  const map = {};
  $("#initRows").querySelectorAll("input[data-comp]").forEach((el) => {
    const v = el.value.trim();
    if (v) map[el.dataset.comp] = v;
  });
  const { error } = await sb.from("devices")
    .upsert({ device_id: CONFIG.DEVICE_ID, slots: map }, { onConflict: "device_id" });
  if (error) { status("save compartments: " + error.message, "err"); return; }
  slots = map; renderSlots();
  status(`saved ${Object.keys(map).length} compartments`, "ok");
  bubble(`Compartments set: ${Object.entries(map).map(([n, s]) => `${n}=${s}`).join(", ")}`);
}
$("#initBtn").onclick = openInit;
$("#saveInit").onclick = saveInit;

// ---------- settings ----------
function openSettings() {
  $("#diKey").value = LS.diKey; $("#ttsOn").checked = LS.tts; $("#settings").showModal();
}
$("#settingsBtn").onclick = openSettings;
$("#saveSettings").onclick = () => { LS.diKey = $("#diKey").value.trim(); LS.tts = $("#ttsOn").checked; };

// ---------- boot ----------
(async function init() {
  bubble("Connect the dispenser, then tap a spice — or Start talking 🎙️");
  await loadDevice(); await loadRecipes();
  if (!Object.keys(slots).length) { bubble("First time? Set up your compartments 🧂"); openInit(); }
})();

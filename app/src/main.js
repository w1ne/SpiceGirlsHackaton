import { createClient } from "@supabase/supabase-js";
import { BleClient, textToDataView, dataViewToText } from "@capacitor-community/bluetooth-le";
import { CONFIG } from "../config.js";

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
let slots = {}, recipes = [];
let deviceId = null;                 // connected BLE device id

const $ = (s) => document.querySelector(s);
const slotsEl = $("#slots"), recipesEl = $("#recipes"), recipesWrap = $("#recipesWrap"),
      statusEl = $("#status"), chatEl = $("#chat"), bleBtn = $("#bleBtn");

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

// ---------- native BLE ----------
async function connectBLE() {
  try {
    status("initialising Bluetooth…");
    await BleClient.initialize({ androidNeverForLocation: true });
    const device = await BleClient.requestDevice({ services: [CONFIG.BLE_SERVICE] });
    await BleClient.connect(device.deviceId, onDisconnect);
    deviceId = device.deviceId;
    await BleClient.startNotifications(deviceId, CONFIG.BLE_SERVICE, CONFIG.BLE_STATUS, (v) => onStatus(v));
    bleBtn.textContent = "🟢 Dispenser"; bleBtn.classList.add("connected");
    status("dispenser connected", "ok");
    bubble("Dispenser connected over Bluetooth ✅");
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
  const summary = steps.map((s) => `${slots[s.slot] || "slot " + s.slot} ×${s.dose_units}`).join(", ");
  bubble(`Dispensing: ${summary}`);
  try {
    const payload = steps.length === 1 ? steps[0] : steps;
    await BleClient.write(deviceId, CONFIG.BLE_SERVICE, CONFIG.BLE_CMD, textToDataView(JSON.stringify(payload)));
  } catch (e) { status("write failed: " + (e.message || e), "err"); }
}

// ---------- boot ----------
(async function init() {
  bubble("Connect the dispenser, then tap a spice 🌶️");
  await loadDevice();
  await loadRecipes();
})();

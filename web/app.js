import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CONFIG } from "./config.js";

// ---------- state ----------
const LS = {
  get diKey() { return localStorage.getItem("di_key") || ""; },
  set diKey(v) { localStorage.setItem("di_key", v); },
  get llm() { return localStorage.getItem("llm_model") || CONFIG.LLM_MODEL; },
  set llm(v) { localStorage.setItem("llm_model", v); },
  get device() { return localStorage.getItem("device_id") || CONFIG.DEVICE_ID; },
  set device(v) { localStorage.setItem("device_id", v); },
  get tts() { return localStorage.getItem("tts") !== "0"; },
  set tts(v) { localStorage.setItem("tts", v ? "1" : "0"); },
};

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
let slots = {};            // {"0":"paprika",...}
let messages = [];         // chat history for the LLM
let mediaRec = null, chunks = [];

// ---------- dom ----------
const $ = (s) => document.querySelector(s);
const chatEl = $("#chat"), statusEl = $("#status"), slotsEl = $("#slots");

function status(msg, cls = "") { statusEl.innerHTML = `<span class="${cls}">${msg}</span>`; }
function bubble(text, who) {
  const d = document.createElement("div");
  d.className = `msg ${who}`; d.textContent = text;
  chatEl.appendChild(d); chatEl.scrollTop = chatEl.scrollHeight;
  return d;
}
function speak(text) {
  if (!LS.tts || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}

// ---------- device / slots ----------
async function loadDevice() {
  const { data, error } = await sb.from("devices").select("*").eq("device_id", LS.device).maybeSingle();
  if (error) { status("device load: " + error.message, "err"); return; }
  slots = (data && data.slots) || {};
  renderSlots();
}
function renderSlots() {
  const entries = Object.entries(slots).sort((a, b) => +a[0] - +b[0]);
  slotsEl.innerHTML = entries.length
    ? entries.map(([s, name]) => `<button class="slot" data-slot="${s}"><b>${name}</b><small>slot ${s} · tap to dispense</small></button>`).join("")
    : `<div class="slot"><small>no slots configured</small></div>`;
  slotsEl.querySelectorAll(".slot[data-slot]").forEach((el) => {
    el.onclick = () => dispense([{ slot: +el.dataset.slot, dose_units: 1 }]);
  });
}

// ---------- DeepInfra: STT ----------
async function transcribe(blob) {
  if (!LS.diKey) throw new Error("Set your DeepInfra key in ⚙️ settings");
  const fd = new FormData();
  fd.append("model", CONFIG.STT_MODEL);
  fd.append("file", blob, "audio.webm");
  const r = await fetch(`${CONFIG.DEEPINFRA_BASE}/audio/transcriptions`, {
    method: "POST", headers: { Authorization: `Bearer ${LS.diKey}` }, body: fd,
  });
  if (!r.ok) throw new Error(`STT ${r.status}: ${await r.text()}`);
  return (await r.json()).text?.trim() || "";
}

// ---------- DeepInfra: LLM ----------
function systemPrompt() {
  const list = Object.entries(slots).sort((a, b) => +a[0] - +b[0])
    .map(([s, n]) => `slot ${s} = ${n}`).join(", ") || "(none)";
  return `You are the brain of a smart spice dispenser. Available spice slots: ${list}.
A "dose_unit" is one sweep of the dispense servo (roughly a pinch); there is no scale.
Help the cook: ask brief CLARIFYING questions ONE at a time (what dish? how many servings?
how spicy do they like it?), then decide which slots to dispense and how many dose_units each.
Only use slots that exist above. Keep replies short and friendly — this is spoken aloud.

ALWAYS reply with a single JSON object, no prose outside it:
{"say": "<what to speak>", "done": <true|false>, "plan": [{"slot": <int>, "dose_units": <int>}] }
While still gathering info: done=false, plan=[].
When ready to dispense: done=true and plan filled in.`;
}
async function askLLM() {
  if (!LS.diKey) throw new Error("Set your DeepInfra key in ⚙️ settings");
  const body = {
    model: LS.llm,
    messages: [{ role: "system", content: systemPrompt() }, ...messages],
    temperature: 0.4,
    response_format: { type: "json_object" },
  };
  const r = await fetch(`${CONFIG.DEEPINFRA_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${LS.diKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${await r.text()}`);
  const content = (await r.json()).choices?.[0]?.message?.content || "{}";
  return parseLoose(content);
}
function parseLoose(s) {
  try { return JSON.parse(s); }
  catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return { say: s, done: false, plan: [] };
  }
}

// ---------- dispense ----------
async function dispense(plan) {
  const rows = (plan || [])
    .filter((p) => p && p.slot != null && p.dose_units > 0)
    .map((p) => ({ device_id: LS.device, type: "dispense",
                   payload: { slot: +p.slot, dose_units: +p.dose_units } }));
  if (!rows.length) return;
  const { error } = await sb.from("commands").insert(rows);
  if (error) { status("dispense insert: " + error.message, "err"); return; }
  const summary = rows.map((r) => `${slots[r.payload.slot] || "slot " + r.payload.slot} ×${r.payload.dose_units}`).join(", ");
  bubble(`Queued: ${summary}`, "sys");
}

// ---------- one conversational turn ----------
async function handleUserText(text) {
  bubble(text, "user");
  messages.push({ role: "user", content: text });
  status("thinking…");
  try {
    const res = await askLLM();
    messages.push({ role: "assistant", content: JSON.stringify(res) });
    const say = res.say || "…";
    bubble(say, "bot"); speak(say);
    if (res.done && Array.isArray(res.plan) && res.plan.length) await dispense(res.plan);
    status("");
  } catch (e) { status(e.message, "err"); bubble("⚠️ " + e.message, "sys"); }
}

// ---------- recording (push-to-talk) ----------
async function startRec() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRec = new MediaRecorder(stream);
    mediaRec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mediaRec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: mediaRec.mimeType || "audio/webm" });
      try {
        status("transcribing…");
        const text = await transcribe(blob);
        if (text) await handleUserText(text);
        else status("(didn't catch that)");
      } catch (e) { status(e.message, "err"); bubble("⚠️ " + e.message, "sys"); }
    };
    mediaRec.start();
    status("listening…");
  } catch (e) { status("mic: " + e.message, "err"); }
}
function stopRec() { if (mediaRec && mediaRec.state !== "inactive") mediaRec.stop(); }

// ---------- realtime status feedback ----------
function subscribeStatus() {
  sb.channel("cmd-status")
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "commands", filter: `device_id=eq.${LS.device}` },
      (p) => {
        const c = p.new; const spice = slots[c.payload?.slot] ?? `slot ${c.payload?.slot}`;
        if (c.status === "running") status(`dispensing ${spice}…`);
        else if (c.status === "done") status(`✓ dispensed ${spice}`, "ok");
        else if (c.status === "error") status(`✗ ${spice}: ${c.error || "error"}`, "err");
      })
    .subscribe();
}

// ---------- settings ----------
function openSettings() {
  $("#diKey").value = LS.diKey; $("#llmModel").value = LS.llm;
  $("#deviceId").value = LS.device; $("#ttsOn").checked = LS.tts;
  $("#settings").showModal();
}
$("#settingsBtn").onclick = openSettings;
$("#saveSettings").onclick = () => {
  LS.diKey = $("#diKey").value.trim(); LS.llm = $("#llmModel").value.trim();
  LS.device = $("#deviceId").value.trim(); LS.tts = $("#ttsOn").checked;
  setTimeout(loadDevice, 50);
};

// ---------- demo mode ----------
function openDemo() {
  const entries = Object.entries(slots).sort((a, b) => +a[0] - +b[0]);
  $("#demoSlots").innerHTML = entries.map(([s, n]) =>
    `<div class="row"><span>${n} <small class="muted">(slot ${s})</small></span>
     <input type="number" min="1" value="2" id="d_${s}"/>
     <button data-slot="${s}">Dispense</button></div>`).join("") || "<p class='muted'>No slots.</p>";
  $("#demoSlots").querySelectorAll("button").forEach((b) => {
    b.onclick = async (e) => {
      e.preventDefault();
      const s = b.dataset.slot, n = +document.getElementById("d_" + s).value || 1;
      await dispense([{ slot: +s, dose_units: n }]);
    };
  });
  $("#demo").showModal();
}
$("#demoBtn").onclick = openDemo;

// ---------- talk button (mouse + touch) ----------
const talk = $("#talkBtn");
const press = (e) => { e.preventDefault(); talk.classList.add("rec"); startRec(); };
const release = (e) => { e.preventDefault(); talk.classList.remove("rec"); stopRec(); };
talk.addEventListener("touchstart", press, { passive: false });
talk.addEventListener("touchend", release, { passive: false });
talk.addEventListener("mousedown", press);
talk.addEventListener("mouseup", release);
talk.addEventListener("mouseleave", () => { if (talk.classList.contains("rec")) release(new Event("x")); });

$("#resetBtn").onclick = () => {
  messages = []; chatEl.innerHTML = "";
  bubble("Tell me what you're cooking 🍳", "bot");
};

// ---------- boot ----------
(async function init() {
  bubble("Tell me what you're cooking 🍳", "bot");
  await loadDevice();
  subscribeStatus();
  if (!LS.diKey) status("Tip: add your DeepInfra key in ⚙️ to enable voice", "");
})();

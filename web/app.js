import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CONFIG } from "./config.js";

// ---------- settings (localStorage) ----------
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
let slots = {};       // {"0":"paprika",...}
let recipes = [];     // [{id,name,steps:[{slot,dose_units}]}]
let messages = [];    // LLM chat history
let busy = false;     // an LLM turn is in flight

// ---------- dom ----------
const $ = (s) => document.querySelector(s);
const chatEl = $("#chat"), statusEl = $("#status"), interimEl = $("#interim"),
      slotsEl = $("#slots"), recipesEl = $("#recipes"), recipesWrap = $("#recipesWrap"),
      micBtn = $("#micBtn");

function status(msg, cls = "") { statusEl.innerHTML = `<span class="${cls}">${msg}</span>`; }
function bubble(text, who) {
  const d = document.createElement("div");
  d.className = `msg ${who}`; d.textContent = text;
  chatEl.appendChild(d); chatEl.scrollTop = chatEl.scrollHeight;
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
    ? entries.map(([s, name]) => `<button class="slot" data-slot="${s}"><b>${name}</b><small>slot ${s} · tap</small></button>`).join("")
    : `<div class="slot"><small>no slots configured</small></div>`;
  slotsEl.querySelectorAll(".slot[data-slot]").forEach((el) => {
    el.onclick = () => dispense([{ slot: +el.dataset.slot, dose_units: 1 }]);
  });
}

// ---------- recipes ----------
async function loadRecipes() {
  const { data, error } = await sb.from("recipes").select("*").order("name");
  if (error) { status("recipes load: " + error.message, "err"); return; }
  recipes = data || [];
  renderRecipes();
}
function renderRecipes() {
  recipesWrap.hidden = recipes.length === 0;
  recipesEl.innerHTML = recipes.map((r) =>
    `<button class="slot" data-recipe="${r.id}"><b>${r.name}</b><small>${(r.steps||[]).length} spices · tap</small></button>`).join("");
  recipesEl.querySelectorAll(".slot[data-recipe]").forEach((el) => {
    el.onclick = () => {
      const r = recipes.find((x) => x.id === el.dataset.recipe);
      if (r) { bubble(`Making "${r.name}"`, "sys"); dispense(r.steps); }
    };
  });
}
async function saveRecipe(name, steps) {
  if (!name || !Array.isArray(steps) || !steps.length) return;
  const { error } = await sb.from("recipes").insert([{ name, steps }]);
  if (error) { status("save recipe: " + error.message, "err"); return; }
  bubble(`Saved recipe "${name}" 📖`, "sys");
  await loadRecipes();
}

// ---------- dispense ----------
async function dispense(plan) {
  const rows = (plan || [])
    .filter((p) => p && p.slot != null && p.dose_units > 0)
    .map((p) => ({ device_id: LS.device, type: "dispense",
                   payload: { slot: +p.slot, dose_units: +p.dose_units } }));
  if (!rows.length) return;
  const { error } = await sb.from("commands").insert(rows);
  if (error) { status("dispense: " + error.message, "err"); return; }
  const summary = rows.map((r) => `${slots[r.payload.slot] || "slot " + r.payload.slot} ×${r.payload.dose_units}`).join(", ");
  bubble(`Dispensing: ${summary}`, "sys");
}

// ---------- DeepInfra LLM ----------
function systemPrompt() {
  const slotList = Object.entries(slots).sort((a, b) => +a[0] - +b[0])
    .map(([s, n]) => `slot ${s}=${n}`).join(", ") || "(none)";
  const recipeList = recipes.length
    ? recipes.map((r) => `"${r.name}": ${JSON.stringify(r.steps)}`).join("; ")
    : "(none yet)";
  return `You are the voice brain of a smart spice dispenser, mid-conversation with a cook.
Spice slots: ${slotList}. A "dose_unit" is one sweep of the dispense servo (a pinch); there is no scale.
Saved recipes: ${recipeList}.

Behaviour:
- Speak naturally and BRIEFLY (this is read aloud). Ask ONE clarifying question at a time
  (what dish? how many servings? how spicy?) until you can decide spices + amounts.
- Only use slots that exist. If the cook asks to "make <recipe name>", use that saved recipe's steps.
- When the cook describes a good mix worth keeping, you MAY save it via save_recipe.

ALWAYS reply with ONE JSON object, nothing else:
{"say": "<spoken reply>",
 "done": <true once you are dispensing now, else false>,
 "plan": [{"slot": <int>, "dose_units": <int>}],
 "save_recipe": null | {"name": "<short name>", "steps": [{"slot": <int>, "dose_units": <int>}]}}
While gathering info: done=false, plan=[]. When dispensing: done=true with plan filled.`;
}
async function askLLM() {
  if (!LS.diKey) throw new Error("Add your DeepInfra key in ⚙️ settings");
  const r = await fetch(`${CONFIG.DEEPINFRA_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${LS.diKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: LS.llm,
      messages: [{ role: "system", content: systemPrompt() }, ...messages],
      temperature: 0.4,
      response_format: { type: "json_object" },
    }),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const content = (await r.json()).choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(content); }
  catch { const m = content.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : { say: content, done: false, plan: [] }; }
}

// ---------- one conversational turn ----------
async function handleUserText(text) {
  if (busy) return;            // ignore overlapping utterances
  busy = true;
  bubble(text, "user");
  messages.push({ role: "user", content: text });
  status("thinking…");
  try {
    const res = await askLLM();
    messages.push({ role: "assistant", content: JSON.stringify(res) });
    const say = res.say || "…";
    bubble(say, "bot");
    if (res.save_recipe) await saveRecipe(res.save_recipe.name, res.save_recipe.steps);
    if (res.done && Array.isArray(res.plan) && res.plan.length) await dispense(res.plan);
    status("");
    speak(say);               // resumes listening when finished
  } catch (e) {
    status(e.message, "err"); bubble("⚠️ " + e.message, "sys");
  } finally { busy = false; }
}

// ---------- TTS (mutes the mic while speaking) ----------
let speaking = false;
function speak(text) {
  if (!LS.tts || !window.speechSynthesis) return;
  speaking = true;
  pauseRecog();
  const u = new SpeechSynthesisUtterance(text);
  u.onend = u.onerror = () => { speaking = false; if (listening) startRecog(); };
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}

// ---------- continuous hands-free recognition ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, listening = false;
function buildRecog() {
  const r = new SR();
  r.lang = "en-US"; r.continuous = true; r.interimResults = true;
  r.onresult = (e) => {
    let interim = "", finalText = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const seg = e.results[i];
      if (seg.isFinal) finalText += seg[0].transcript; else interim += seg[0].transcript;
    }
    interimEl.textContent = interim;
    if (finalText.trim()) { interimEl.textContent = ""; handleUserText(finalText.trim()); }
  };
  r.onend = () => { if (listening && !speaking) startRecog(); };   // auto-restart
  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      status("mic permission denied", "err"); stopConversation();
    }
  };
  return r;
}
function startRecog() { try { recog.start(); } catch (_) {} }
function pauseRecog() { try { recog && recog.stop(); } catch (_) {} }
function startConversation() {
  if (!SR) { status("This browser has no live speech recognition — use tap-to-dispense or the ⚡ demo", "err"); return; }
  if (!LS.diKey) { status("Add your DeepInfra key in ⚙️ first", "err"); return; }
  recog = buildRecog(); listening = true; startRecog();
  micBtn.textContent = "⏹ Stop listening"; micBtn.classList.add("listening");
  status("listening — just talk", "");
}
function stopConversation() {
  listening = false; pauseRecog();
  micBtn.textContent = "🎙️ Start conversation"; micBtn.classList.remove("listening");
  interimEl.textContent = ""; status("");
}
micBtn.onclick = () => (listening ? stopConversation() : startConversation());

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
  setTimeout(() => { loadDevice(); loadRecipes(); }, 50);
};

// ---------- demo mode (custom dose) ----------
function openDemo() {
  const entries = Object.entries(slots).sort((a, b) => +a[0] - +b[0]);
  $("#demoSlots").innerHTML = entries.map(([s, n]) =>
    `<div class="row"><span>${n} <small class="muted">(slot ${s})</small></span>
     <input type="number" min="1" value="2" id="d_${s}"/>
     <button data-slot="${s}">Dispense</button></div>`).join("") || "<p class='muted'>No slots.</p>";
  $("#demoSlots").querySelectorAll("button").forEach((b) => {
    b.onclick = (e) => { e.preventDefault();
      dispense([{ slot: +b.dataset.slot, dose_units: +document.getElementById("d_" + b.dataset.slot).value || 1 }]); };
  });
  $("#demo").showModal();
}
$("#demoBtn").onclick = openDemo;

$("#resetBtn").onclick = () => {
  messages = []; chatEl.innerHTML = "";
  bubble("Tell me what you're cooking 🍳", "bot");
};

// ---------- realtime status ----------
function subscribeStatus() {
  sb.channel("cmd-status")
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "commands", filter: `device_id=eq.${LS.device}` },
      (p) => {
        const c = p.new, spice = slots[c.payload?.slot] ?? `slot ${c.payload?.slot}`;
        if (c.status === "running") status(`dispensing ${spice}…`);
        else if (c.status === "done") status(`✓ dispensed ${spice}`, "ok");
        else if (c.status === "error") status(`✗ ${spice}: ${c.error || "error"}`, "err");
      })
    .subscribe();
}

// ---------- boot ----------
(async function init() {
  bubble("Tap “Start conversation” and tell me what you're cooking 🍳", "bot");
  await loadDevice();
  await loadRecipes();
  subscribeStatus();
  if (!SR) status("No live speech in this browser — tap-to-dispense still works", "");
  else if (!LS.diKey) status("Add your DeepInfra key in ⚙️ to enable voice", "");
})();

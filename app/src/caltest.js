// Calibration & test screen — the serial bench console (tools/serial-console.html)
// as an in-app dialog, talking over BLE instead of USB. Firmware ≥1.4 accepts the
// same {"cmd":...} JSON on the command characteristic and notifies {"ok":...}
// replies on the status characteristic; main.js routes those lines here.
//
// createCalTest({ send, dispense }) → { open, onLine }
//   send(obj)      write one JSON command line to the dispenser (throws if offline)
//   dispense(plan) the app's normal dispense path (used by the test buttons)
//   open()         show the dialog (lazy-builds its DOM on first use)
//   onLine(j, raw) feed every parsed status-characteristic line (any kind)

// Pure helpers (unit-tested) ---------------------------------------------------

// Human label for the status report's revolver drive.
export const DRV_LABELS = {
  sts: "STS3215 closed-loop", spin: "PWM-360 continuous", pos: "positional 180°",
  pwm: "PWM-360 continuous", // pre-1.4 firmware
};
export function driveLabel(j) {
  const base = DRV_LABELS[j.mode] || j.mode || "—";
  return j.drive === "auto" ? base + " (auto)" : base;
}

// status report → field strings for the kv grid
export function statusFields(j) {
  return {
    mode: driveLabel(j),
    sts: j.stsOk ? "answering" : "not found",
    pos: j.stsPos >= 0 ? `${j.stsPos} ticks (${(j.stsPos * 360 / 4096).toFixed(1)}°)` : "—",
    slot: j.slot > 0 ? String(j.slot) : "unknown (raw move)",
    pca: j.pcaAck ? "ack" : "no ack — servo power?",
    i2c: String(j.i2cErrs ?? "—"),
    fw: `${j.fw || "?"} · ${j.build || ""}`,
  };
}

// calibration inputs → the {"cmd":"cal",...} save payload.
// An EMPTY angle field means "slot not available on this unit" (a 180° servo
// reaches only ~half the carousel) and is sent as -1 — the firmware refuses to
// dispense those slots in positional mode.
export function calSavePayload(v) {
  return {
    cmd: "cal",
    slot1_offset: +v.offset, ms_per_slot: +v.msPerSlot,
    shutter_open: +v.shutterOpen, shutter_closed: +v.shutterClosed,
    sts_speed: +v.stsSpeed, sts_acc: +v.stsAcc, spin_us: +v.spinUs, pos_speed: +v.posSpeed,
    revolver: v.revolver,
    slot_angles: v.slotAngles.map((a) => String(a).trim() === "" ? -1 : +a),
    slot_ticks: v.slotTicks.map((t) => String(t).trim() === "" ? -1 : +t),
  };
}

// cal reply → which slots exist on this unit. Only the positional drive can
// have missing slots; every other drive reaches all six.
export function slotAvailability(j) {
  const all = [true, true, true, true, true, true];
  if (j.revolver !== "pos" || !Array.isArray(j.slot_angles)) return all;
  return all.map((_, i) => j.slot_angles[i] >= 0);
}

// Dialog ------------------------------------------------------------------------

const HTML = `
<form method="dialog">
  <h2>🛠 Calibration &amp; test</h2>

  <h3>Status <button type="button" id="ctProbe" title="re-scan servos after hot-plugging">Probe</button>
      <label class="ct-poll"><input type="checkbox" id="ctPoll" checked> auto</label></h3>
  <div class="ct-kv">
    <b>revolver</b><span id="ctMode">—</span>
    <b>bus servo</b><span id="ctSts">—</span>
    <b>encoder</b><span id="ctPos">—</span>
    <b>slot</b><span id="ctSlot">—</span>
    <b>PCA9685</b><span id="ctPca">—</span>
    <b>I²C errors</b><span id="ctI2c">—</span>
    <b>firmware</b><span id="ctFw">—</span>
  </div>

  <h3>Test dispense</h3>
  <div class="ct-slots" id="ctSlots"></div>
  <label class="row">dose <input type="number" id="ctDose" value="1" min="1" max="9"></label>

  <h3 class="drv drv-sts">Revolver — raw position (bus servo)</h3>
  <input class="drv drv-sts" type="range" id="ctStsSlider" min="0" max="4095" value="0">
  <div class="row drv drv-sts">
    <input type="number" id="ctStsPos" min="0" max="4095" value="0">
    <button type="button" id="ctStsGo">Go</button>
    <button type="button" id="ctStsRead">Read</button>
    <span id="ctStsActual" class="muted">actual: —</span>
  </div>
  <div class="row drv drv-sts">
    <button type="button" id="ctTorqueOff" title="free the servo so the carousel turns by hand">Free (hand-turn)</button>
    <button type="button" id="ctTorqueOn" title="re-engage the servo">Lock</button>
    <span class="muted">hand calibration: Free, turn to a compartment, store its tick below</span>
  </div>

  <h3 class="drv drv-pos">Revolver — angle (180° servo)</h3>
  <input class="drv drv-pos" type="range" id="ctAngSlider" min="0" max="180" value="90">
  <div class="row drv drv-pos">
    <input type="number" id="ctAngVal" min="0" max="180" value="90">
    <button type="button" id="ctAngGo">Go</button>
    <span class="muted">drives the PWM revolver directly</span>
  </div>
  <div class="row drv drv-pos">store angle as slot
    <span id="ctAngStore"></span></div>
  <div class="muted ct-note drv drv-pos">jog until a compartment is under the chute, then tap its number — the angle lands in slot° below; Save to board to persist</div>

  <h3>Shutter</h3>
  <div class="row">
    <button type="button" id="ctShOpen">Open</button>
    <button type="button" id="ctShClose">Close</button>
    <button type="button" id="ctShOff">Release</button>
  </div>

  <h3>Raw PCA</h3>
  <div class="row">ch <input type="number" id="ctPcaCh" value="8" min="0" max="15">
    µs <input type="number" id="ctPcaUs" value="1500" min="500" max="2500">
    <button type="button" id="ctPcaSet">Set</button>
    <button type="button" id="ctPcaOff">Off</button></div>

  <h3>LED</h3>
  <div class="row" id="ctLeds"></div>

  <h3>Calibration <button type="button" id="ctCalRead">Read</button>
      <span class="muted ct-note">saved to the board's flash</span></h3>
  <div class="row drv drv-sts">slot 1 offset
    <input type="number" id="ctCalOff" min="0" max="4095" value="0">
    <button type="button" id="ctCalHome" title="snap to where the carousel sits now">Home = current</button></div>
  <div class="muted ct-note drv drv-sts">jog with the raw slider until compartment 1 is under the chute, then Home</div>
  <div class="row drv drv-sts">STS speed <input type="number" id="ctCalStsSpd" min="50" max="4095" value="1000">
    acc <input type="number" id="ctCalStsAcc" min="0" max="254" value="50"></div>
  <div class="row ct-angles drv drv-sts">slot ticks
    ${[1, 2, 3, 4, 5, 6].map((s) =>
      `<input type="number" class="ctTick" data-slot="${s}" min="0" max="4095" title="compartment ${s} encoder tick">`).join("")}
  </div>
  <div class="row drv drv-sts">store tick as slot <span id="ctTickStore"></span></div>
  <div class="muted ct-note drv drv-sts">per-compartment encoder position — overrides the computed spacing; leave empty to fall back to slot-1-offset math</div>
  <div class="row drv drv-spin">ms / compartment <input type="number" id="ctCalMs" min="50" max="5000" value="500"></div>
  <div class="row drv drv-spin">spin µs <input type="number" id="ctCalSpinUs" min="1000" max="2000" value="1600"></div>
  <div class="muted ct-note drv drv-spin">spin µs sets the spin speed — recheck ms/compartment after changing it</div>
  <div class="row drv drv-pos">180° speed <input type="number" id="ctCalPosSpd" min="10" max="720" value="90"> °/s
    <span class="muted">(720 = instant)</span></div>
  <div class="row">shutter open <input type="number" id="ctCalShO" min="0" max="180" value="120">
    closed <input type="number" id="ctCalShC" min="0" max="180" value="20"></div>
  <label>revolver drive
    <select id="ctCalRev">
      <option value="auto">auto (bus servo if found, else spin)</option>
      <option value="sts">bus servo (STS3215)</option>
      <option value="spin">continuous spin (MG90S-360)</option>
      <option value="pos">positional 180° servo</option>
    </select></label>
  <div class="row ct-angles drv drv-pos">slot°
    ${[0, 30, 60, 90, 120, 150].map((a, i) =>
      `<input type="number" class="ctAng" data-slot="${i + 1}" min="0" max="180" value="${a}" title="compartment ${i + 1} angle">`).join("")}
  </div>
  <div class="muted ct-note drv drv-pos">per-compartment servo angle — leave a slot EMPTY if the 180° servo can't reach it (the app + agents will skip it)</div>
  <div class="row">
    <button type="button" id="ctCalSave" class="ct-primary">Save to board</button>
    <button type="button" id="ctCalReset" title="restore firmware defaults">Reset</button>
    <span id="ctCalSaved" class="ok"></span>
  </div>

  <h3>Console</h3>
  <div id="ctLog" class="ct-log"></div>
  <div class="row">
    <input type="text" id="ctRaw" placeholder='{"cmd":"status"}' class="ct-raw">
    <button type="button" id="ctSend">Send</button>
  </div>

  <div class="actions"><button value="close" class="ghost">Close</button></div>
</form>`;

export function createCalTest({ send, dispense }) {
  const dlg = document.getElementById("caltest");
  let built = false, pollTimer = null;
  const $ = (id) => dlg.querySelector("#" + id);

  function log(line, cls) {
    const el = $("ctLog");
    if (!el) return;
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = line;
    el.appendChild(d);
    while (el.childElementCount > 200) el.firstChild.remove();
    el.scrollTop = el.scrollHeight;
  }

  async function tx(obj) {
    log("> " + JSON.stringify(obj), "tx");
    try { await send(obj); }
    catch (e) { log("send failed: " + (e.message || e), "err"); }
  }

  function build() {
    built = true;
    dlg.innerHTML = HTML;
    for (let s = 1; s <= 6; s++) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = s;
      b.onclick = () => dispense([{ slot: s, dose_units: +$("ctDose").value || 1 }]).catch((e) => log(e.message, "err"));
      $("ctSlots").appendChild(b);
    }
    [["#000000", 0, 0, 0], ["#ff3030", 60, 0, 0], ["#30ff30", 0, 60, 0], ["#3060ff", 0, 0, 60], ["#ffffff", 60, 60, 60]]
      .forEach(([hex, r, g, b]) => {
        const d = document.createElement("button");
        d.type = "button"; d.className = "ct-sw"; d.style.background = hex; d.title = `led ${r},${g},${b}`;
        d.onclick = () => tx({ cmd: "led", r, g, b });
        $("ctLeds").appendChild(d);
      });
    $("ctProbe").onclick = () => tx({ cmd: "probe" });
    $("ctStsSlider").oninput = () => $("ctStsPos").value = $("ctStsSlider").value;
    $("ctStsGo").onclick = () => tx({ cmd: "sts", pos: +$("ctStsPos").value });
    $("ctStsRead").onclick = () => tx({ cmd: "sts" });
    // STS hand calibration: free/lock torque, store the encoder reading per slot
    $("ctTorqueOff").onclick = () => tx({ cmd: "sts", torque: 0 });
    $("ctTorqueOn").onclick = () => tx({ cmd: "sts", torque: 1 });
    for (let s = 1; s <= 6; s++) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = s;
      // read the encoder fresh, then onLine() drops the reply into this slot's field
      b.onclick = () => { pendingTickSlot = s; tx({ cmd: "sts" }); };
      $("ctTickStore").appendChild(b);
    }
    // 180° positional revolver: jog by angle (PCA ch8), then store per-slot
    $("ctAngSlider").oninput = () => $("ctAngVal").value = $("ctAngSlider").value;
    $("ctAngGo").onclick = () => tx({ cmd: "pca", ch: 8, deg: +$("ctAngVal").value });
    for (let s = 1; s <= 6; s++) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = s;
      b.onclick = () => {
        const ang = +$("ctAngVal").value;
        dlg.querySelector(`.ctAng[data-slot="${s}"]`).value = ang;
        log(`slot ${s} angle = ${ang}° (Save to board to persist)`, "tx");
      };
      $("ctAngStore").appendChild(b);
    }
    // shutter buttons use the CURRENT calibration inputs, so you can try an angle
    // before saving it
    $("ctShOpen").onclick = () => tx({ cmd: "pca", ch: 12, deg: +$("ctCalShO").value });
    $("ctShClose").onclick = () => tx({ cmd: "pca", ch: 12, deg: +$("ctCalShC").value });
    $("ctShOff").onclick = () => tx({ cmd: "pca", ch: 12, off: true });
    $("ctPcaSet").onclick = () => tx({ cmd: "pca", ch: +$("ctPcaCh").value, us: +$("ctPcaUs").value });
    $("ctPcaOff").onclick = () => tx({ cmd: "pca", ch: +$("ctPcaCh").value, off: true });
    $("ctCalRead").onclick = () => tx({ cmd: "cal" });
    $("ctCalHome").onclick = () => tx({ cmd: "cal", home: true });
    $("ctCalReset").onclick = () => tx({ cmd: "cal", reset: true });
    $("ctCalSave").onclick = () => tx(calSavePayload({
      offset: $("ctCalOff").value, msPerSlot: $("ctCalMs").value,
      shutterOpen: $("ctCalShO").value, shutterClosed: $("ctCalShC").value,
      stsSpeed: $("ctCalStsSpd").value, stsAcc: $("ctCalStsAcc").value, spinUs: $("ctCalSpinUs").value,
      posSpeed: $("ctCalPosSpd").value,
      revolver: $("ctCalRev").value,
      slotAngles: [...dlg.querySelectorAll(".ctAng")].map((el) => el.value),
      slotTicks: [...dlg.querySelectorAll(".ctTick")].map((el) => el.value),
    }));
    $("ctSend").onclick = () => { const v = $("ctRaw").value.trim(); if (v) { log("> " + v, "tx"); send(v).catch((e) => log("send failed: " + (e.message || e), "err")); } };
    // preview the relevant controls when the user picks a drive (before saving)
    $("ctCalRev").onchange = () => applyDrive($("ctCalRev").value === "auto" ? lastMode : $("ctCalRev").value);
    dlg.addEventListener("close", stopPoll);
  }

  // Show only the controls for the drive this board actually runs — a bus-servo
  // unit doesn't need 180° angles, a 180° unit doesn't need encoder homing.
  // Everything is shown until the first status/cal reply tells us the drive.
  let lastMode = "";
  let pendingTickSlot = 0;   // "store tick as slot N" waits for the next encoder read
  function applyDrive(drv) {
    if (!drv) return;
    dlg.querySelectorAll(".drv").forEach((el) => { el.style.display = el.classList.contains("drv-" + drv) ? "" : "none"; });
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(() => { if (dlg.open && $("ctPoll").checked) tx({ cmd: "status" }); }, 2000);
  }
  function stopPoll() { clearInterval(pollTimer); pollTimer = null; }

  function open() {
    if (!built) build();
    dlg.showModal();
    tx({ cmd: "status" });
    tx({ cmd: "cal" });
    startPoll();
  }

  // Every status-characteristic line lands here (main.js routes them); update the
  // widgets for cmd replies and mirror everything in the console log while open.
  function onLine(j, raw) {
    if (!built || !dlg.open) return;
    log(raw, j.ok === false || j.status === "error" ? "err" : "ok");
    if (j.cmd === "status") {
      const m = j.mode === "pwm" ? "spin" : j.mode;   // pre-1.4 firmware says "pwm"
      if (m && m !== lastMode) { lastMode = m; applyDrive(m); }
      const f = statusFields(j);
      $("ctMode").textContent = f.mode; $("ctSts").textContent = f.sts;
      $("ctPos").textContent = f.pos; $("ctSlot").textContent = f.slot;
      $("ctPca").textContent = f.pca; $("ctI2c").textContent = f.i2c;
      $("ctFw").textContent = f.fw;
      if (j.stsPos >= 0) { $("ctStsSlider").value = j.stsPos; $("ctStsActual").textContent = "actual: " + j.stsPos; }
    }
    if (j.cmd === "sts" && j.ok && j.pos !== undefined) {
      $("ctStsActual").textContent = "actual: " + j.pos;
      $("ctStsSlider").value = j.pos; $("ctStsPos").value = j.pos;
      if (pendingTickSlot) {
        dlg.querySelector(`.ctTick[data-slot="${pendingTickSlot}"]`).value = j.pos;
        log(`slot ${pendingTickSlot} tick = ${j.pos} (Save to board to persist)`, "tx");
        pendingTickSlot = 0;
      }
    }
    if (j.cmd === "cal") {
      if ("slot1_offset" in j) $("ctCalOff").value = j.slot1_offset;
      if ("ms_per_slot" in j) $("ctCalMs").value = j.ms_per_slot;
      if ("shutter_open" in j) $("ctCalShO").value = j.shutter_open;
      if ("shutter_closed" in j) $("ctCalShC").value = j.shutter_closed;
      if ("sts_speed" in j) $("ctCalStsSpd").value = j.sts_speed;
      if ("sts_acc" in j) $("ctCalStsAcc").value = j.sts_acc;
      if ("spin_us" in j) $("ctCalSpinUs").value = j.spin_us;
      if ("pos_speed" in j) $("ctCalPosSpd").value = j.pos_speed;
      if ("revolver" in j) $("ctCalRev").value = j.revolver;
      if (Array.isArray(j.slot_angles)) dlg.querySelectorAll(".ctAng").forEach((el, i) => el.value = j.slot_angles[i] < 0 ? "" : j.slot_angles[i]);
      if (Array.isArray(j.slot_ticks)) dlg.querySelectorAll(".ctTick").forEach((el, i) => el.value = j.slot_ticks[i] < 0 ? "" : j.slot_ticks[i]);
      $("ctCalSaved").textContent = j.saved ? "saved ✓" : "read";
      setTimeout(() => { const el = $("ctCalSaved"); if (el) el.textContent = ""; }, 1600);
      // grey the test-dispense buttons for slots this unit can't reach
      const avail = slotAvailability(j);
      $("ctSlots").querySelectorAll("button").forEach((b, i) => b.disabled = !avail[i]);
    }
  }

  return { open, onLine };
}

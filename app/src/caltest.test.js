import { describe, test, expect } from "vitest";
import { driveLabel, statusFields, calSavePayload, slotAvailability } from "./caltest.js";

// ---------- revolver drive label (status card) ----------
describe("driveLabel", () => {
  test("names each drive", () => {
    expect(driveLabel({ mode: "sts" })).toBe("STS3215 closed-loop");
    expect(driveLabel({ mode: "spin" })).toBe("PWM-360 continuous");
    expect(driveLabel({ mode: "pos" })).toBe("positional 180°");
  });

  test("marks auto-resolved drives", () => {
    expect(driveLabel({ mode: "sts", drive: "auto" })).toBe("STS3215 closed-loop (auto)");
    expect(driveLabel({ mode: "spin", drive: "spin" })).toBe("PWM-360 continuous");
  });

  test("understands pre-1.4 firmware that reports mode pwm", () => {
    expect(driveLabel({ mode: "pwm" })).toBe("PWM-360 continuous");
  });
});

// ---------- status report → display fields ----------
describe("statusFields", () => {
  const report = {
    cmd: "status", fw: "1.4.0", mode: "sts", drive: "auto", stsOk: true, stsPos: 2048,
    slot: 3, pcaAck: true, i2cErrs: 0, build: "Jun  6 2026",
  };

  test("formats a healthy report", () => {
    const f = statusFields(report);
    expect(f.sts).toBe("answering");
    expect(f.pos).toBe("2048 ticks (180.0°)");
    expect(f.slot).toBe("3");
    expect(f.pca).toBe("ack");
    expect(f.fw).toContain("1.4.0");
  });

  test("flags missing hardware", () => {
    const f = statusFields({ ...report, stsOk: false, stsPos: -1, pcaAck: false, slot: 0 });
    expect(f.sts).toBe("not found");
    expect(f.pos).toBe("—");
    expect(f.slot).toMatch(/unknown/);
    expect(f.pca).toMatch(/servo power/);
  });
});

// ---------- calibration inputs → save command ----------
describe("calSavePayload", () => {
  test("builds the full cal command with numeric fields", () => {
    const p = calSavePayload({
      offset: "2048", msPerSlot: "500", shutterOpen: "120", shutterClosed: "20", shutterMs: "300",
      stsSpeed: "1000", stsAcc: "50", spinUs: "1600", posSpeed: "90",
      revolver: "sts", slotAngles: ["0", "30", "60", "90", "120", "150"], slotTicks: ["125", "744", "1436", "2205", "2847", ""],
    });
    expect(p).toEqual({
      cmd: "cal",
      slot1_offset: 2048, ms_per_slot: 500, shutter_open: 120, shutter_closed: 20, shutter_ms: 300,
      sts_speed: 1000, sts_acc: 50, spin_us: 1600, pos_speed: 90,
      revolver: "sts", slot_angles: [0, 30, 60, 90, 120, 150], slot_ticks: [125, 744, 1436, 2205, 2847, -1],
    });
  });

  test("empty angle fields mark a slot not-available (-1)", () => {
    const p = calSavePayload({
      offset: "0", msPerSlot: "500", shutterOpen: "120", shutterClosed: "20", shutterMs: "300",
      stsSpeed: "1000", stsAcc: "50", spinUs: "1600", posSpeed: "90",
      revolver: "pos", slotAngles: ["10", "70", "130", "", " ", ""], slotTicks: ["", "", "", "", "", ""],
    });
    expect(p.slot_angles).toEqual([10, 70, 130, -1, -1, -1]);
  });
});

// ---------- cal reply → which slots exist on this unit ----------
describe("slotAvailability", () => {
  test("positional drive: negative angles mean the slot is missing", () => {
    const a = slotAvailability({ revolver: "pos", slot_angles: [10, 70, 130, -1, -1, -1] });
    expect(a).toEqual([true, true, true, false, false, false]);
  });

  test("non-positional drives reach all six slots regardless of angles", () => {
    expect(slotAvailability({ revolver: "auto", slot_angles: [-1, -1, -1, -1, -1, -1] }))
      .toEqual([true, true, true, true, true, true]);
    expect(slotAvailability({ revolver: "sts" })).toEqual([true, true, true, true, true, true]);
  });
});

import { describe, test, expect, vi } from "vitest";
import { validateDispense, runTool, TOOL_DEFS } from "./tools.js";

// ---------- #5: dose bounds + allergen safety (validateDispense) ----------
describe("validateDispense", () => {
  const compartments = { 1: "paprika", 2: "cumin", 3: "salt" };

  test("passes valid in-range steps through unchanged", () => {
    const r = validateDispense([{ slot: 1, dose_units: 2 }], { compartments });
    expect(r.ok).toBe(true);
    expect(r.steps).toEqual([{ slot: 1, dose_units: 2 }]);
  });

  test("clamps dose_units above the max instead of pouring a huge amount", () => {
    const r = validateDispense([{ slot: 1, dose_units: 99 }], { compartments, maxDose: 20 });
    expect(r.ok).toBe(true);
    expect(r.steps[0].dose_units).toBe(20);
    expect(r.warnings.join(" ")).toMatch(/clamp/i);
  });

  test("drops steps for compartments out of the 1-6 range", () => {
    const r = validateDispense([{ slot: 9, dose_units: 1 }, { slot: 1, dose_units: 1 }], { compartments });
    expect(r.steps).toEqual([{ slot: 1, dose_units: 1 }]);
  });

  test("drops steps for empty compartments", () => {
    const r = validateDispense([{ slot: 6, dose_units: 1 }, { slot: 2, dose_units: 1 }], { compartments });
    expect(r.steps).toEqual([{ slot: 2, dose_units: 1 }]);
  });

  test("fails with no valid steps left", () => {
    const r = validateDispense([{ slot: 6, dose_units: 1 }], { compartments });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no valid steps/i);
  });

  test("HARD-BLOCKS the whole dispense if any step holds an allergen", () => {
    const r = validateDispense(
      [{ slot: 1, dose_units: 1 }, { slot: 2, dose_units: 1 }],
      { compartments, allergens: ["cumin"] }
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cumin/i);
    expect(r.error).toMatch(/allerg/i);
    expect(r.steps).toEqual([]); // never pour ANYTHING when an allergen is in the plan
  });

  test("allergen match is case-insensitive and substring-aware", () => {
    const r = validateDispense([{ slot: 1, dose_units: 1 }], {
      compartments: { 1: "Smoked Paprika" },
      allergens: ["PAPRIKA"],
    });
    expect(r.ok).toBe(false);
  });
});

// ---------- runTool wires the validator into the dispense path ----------
describe("runTool dispense", () => {
  const baseCtx = () => ({
    dispense: vi.fn().mockResolvedValue(undefined),
    getState: () => ({ compartments: { 1: "paprika", 2: "cumin" }, mixes: [], preferences: {}, allergens: [] }),
  });

  test("does NOT call ctx.dispense when an allergen is in the plan", async () => {
    const ctx = baseCtx();
    ctx.getState = () => ({ compartments: { 1: "paprika", 2: "cumin" }, mixes: [], preferences: {}, allergens: ["cumin"] });
    const res = await runTool("dispense", { steps: [{ compartment: 2, dose_units: 1 }] }, ctx);
    expect(ctx.dispense).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/allerg/i);
  });

  test("clamps an over-max dose before dispensing", async () => {
    const ctx = baseCtx();
    const res = await runTool("dispense", { steps: [{ compartment: 1, dose_units: 500 }] }, ctx);
    expect(res.ok).toBe(true);
    expect(ctx.dispense).toHaveBeenCalledWith([{ slot: 1, dose_units: 20 }]);
  });
});

// ---------- fill by voice: "put cumin in 1, paprika in 2" ----------
describe("runTool set_compartments", () => {
  test("records the spice→compartment map the cook dictates", async () => {
    const saved = {};
    const ctx = {
      saveCompartments: vi.fn(async (map) => Object.assign(saved, map)),
      getState: () => ({ compartments: saved }),
    };
    const res = await runTool("set_compartments", {
      assignments: [{ compartment: 1, spice: "cumin" }, { compartment: 2, spice: "paprika" }],
    }, ctx);
    expect(res.ok).toBe(true);
    expect(ctx.saveCompartments).toHaveBeenCalledWith({ 1: "cumin", 2: "paprika" });
    expect(res.compartments).toEqual({ 1: "cumin", 2: "paprika" });
  });

  test("ignores incomplete assignments (missing compartment or spice)", async () => {
    const ctx = { saveCompartments: vi.fn().mockResolvedValue(undefined), getState: () => ({ compartments: {} }) };
    await runTool("set_compartments", {
      assignments: [{ compartment: 3, spice: "salt" }, { compartment: 4 }, { spice: "pepper" }, null],
    }, ctx);
    expect(ctx.saveCompartments).toHaveBeenCalledWith({ 3: "salt" });
  });
});

// ---------- #4: personalization (preferences + allergens) ----------
describe("runTool preferences", () => {
  test("set_preference persists a key/value via ctx", async () => {
    const ctx = { setPreference: vi.fn().mockResolvedValue(undefined) };
    const res = await runTool("set_preference", { key: "salt_level", value: "light" }, ctx);
    expect(res.ok).toBe(true);
    expect(ctx.setPreference).toHaveBeenCalledWith("salt_level", "light");
  });

  test("set_preference rejects an empty key", async () => {
    const ctx = { setPreference: vi.fn() };
    const res = await runTool("set_preference", { key: "", value: "x" }, ctx);
    expect(res.ok).toBe(false);
    expect(ctx.setPreference).not.toHaveBeenCalled();
  });

  test("set_allergens stores a normalized spice list", async () => {
    const ctx = { setAllergens: vi.fn().mockResolvedValue(undefined) };
    const res = await runTool("set_allergens", { spices: [" Cumin ", "PAPRIKA", ""] }, ctx);
    expect(res.ok).toBe(true);
    expect(ctx.setAllergens).toHaveBeenCalledWith(["cumin", "paprika"]);
  });
});

// the new tools must be advertised to the model
describe("tool surface", () => {
  test("exposes set_preference and set_allergens", () => {
    const names = TOOL_DEFS.map((t) => t.function.name);
    expect(names).toContain("set_preference");
    expect(names).toContain("set_allergens");
  });
});

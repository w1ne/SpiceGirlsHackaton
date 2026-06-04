// The dispenser agent's TOOL SURFACE — one canonical definition.
// Used by the current DeepInfra LLM (function calling) and ready to hand to a
// realtime voice model (OpenAI Realtime / Gemini Live use the same schema).
// Clarifying questions are NOT a tool — the model just asks them in speech.
//
// Tools speak in "compartment" (1-6); runTool maps to the BLE "slot" field.

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "set_compartments",
      description:
        "Record which spice is loaded in which compartment (1-6). Call when the cook says what they put where.",
      parameters: {
        type: "object",
        properties: {
          assignments: {
            type: "array",
            description: "One entry per compartment the cook mentions.",
            items: {
              type: "object",
              properties: {
                compartment: { type: "integer", minimum: 1, maximum: 6 },
                spice: { type: "string" },
              },
              required: ["compartment", "spice"],
            },
          },
        },
        required: ["assignments"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dispense",
      description:
        "Run the motors to dispense spices now. dose_units = number of pinch sweeps. Only use compartments that contain a spice.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                compartment: { type: "integer", minimum: 1, maximum: 6 },
                dose_units: { type: "integer", minimum: 1, maximum: 20 },
              },
              required: ["compartment", "dose_units"],
            },
          },
        },
        required: ["steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_mix",
      description: "Save a reusable spice mix (recipe) so the cook can ask for it by name later.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                compartment: { type: "integer", minimum: 1, maximum: 6 },
                dose_units: { type: "integer", minimum: 1, maximum: 20 },
              },
              required: ["compartment", "dose_units"],
            },
          },
        },
        required: ["name", "steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_state",
      description: "Get the current compartment contents and saved mixes.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "set_preference",
      description:
        "Remember a lasting taste preference for this cook (e.g. key 'salt_level' value 'light', or 'heat' 'mild'). Call when they express how they generally like things, not a one-off.",
      parameters: {
        type: "object",
        properties: { key: { type: "string" }, value: { type: "string" } },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_allergens",
      description:
        "Record spices the cook is allergic to or wants to always avoid. These are HARD-BLOCKED from any dispense. Call whenever they mention an allergy.",
      parameters: {
        type: "object",
        properties: { spices: { type: "array", items: { type: "string" } } },
        required: ["spices"],
      },
    },
  },
];

// Same tools, flattened for the OpenAI Realtime session schema.
export function realtimeTools() {
  return TOOL_DEFS.map((t) => ({
    type: "function",
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}

// Guard the dispense plan before any motor runs (#5). Two jobs:
//   1. Allergen safety — if ANY step pours a spice the cook flagged as an
//      allergy, block the ENTIRE dispense (never partially pour around it).
//   2. Sanity bounds — drop out-of-range/empty compartments, clamp the dose so
//      an ungrounded model can't ask for 500 pinches of chili.
// Returns { ok, steps, error?, warnings[] }. steps is the sanitised plan.
const DEFAULT_MAX_DOSE = 20;
export function validateDispense(steps, { compartments = {}, allergens = [], maxDose = DEFAULT_MAX_DOSE } = {}) {
  const warnings = [];
  const allergyList = (allergens || []).map((a) => String(a).toLowerCase().trim()).filter(Boolean);

  // Safety first: scan the WHOLE plan for allergens before pouring anything.
  for (const s of steps || []) {
    const spice = String(compartments[s && s.slot] || "").toLowerCase();
    const hit = allergyList.find((a) => spice && (spice.includes(a) || a.includes(spice)));
    if (hit) {
      return {
        ok: false,
        steps: [],
        error: `Blocked: compartment ${s.slot} holds ${compartments[s.slot]} and you told me you're allergic to ${hit}. Not dispensing.`,
        warnings,
      };
    }
  }

  const clean = [];
  for (const s of steps || []) {
    const slot = +(s && s.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > 6) { warnings.push(`ignored compartment ${s && s.slot}: out of range`); continue; }
    if (!compartments[slot]) { warnings.push(`ignored compartment ${slot}: empty`); continue; }
    let dose = Math.floor(+s.dose_units);
    if (!(dose >= 1)) { warnings.push(`ignored compartment ${slot}: dose ${s.dose_units}`); continue; }
    if (dose > maxDose) { warnings.push(`clamped compartment ${slot} dose ${dose}→${maxDose}`); dose = maxDose; }
    clean.push({ slot, dose_units: dose });
  }
  if (!clean.length) return { ok: false, steps: [], error: "no valid steps", warnings };
  return { ok: true, steps: clean, warnings };
}

// Execute a tool call. ctx supplies the app's side-effecting actions:
//   ctx.dispense(steps[{slot,dose_units}]) · ctx.saveCompartments(map{n:spice})
//   ctx.saveMix(name, steps[{slot,dose_units}]) · ctx.getState()
export async function runTool(name, args, ctx) {
  try {
    switch (name) {
      case "set_compartments": {
        const map = {};
        for (const a of args.assignments || []) if (a && a.compartment && a.spice) map[a.compartment] = a.spice;
        await ctx.saveCompartments(map);
        return { ok: true, compartments: ctx.getState().compartments };
      }
      case "dispense": {
        const raw = (args.steps || []).map((s) => ({ slot: +(s && s.compartment), dose_units: +(s && s.dose_units) }));
        const st = ctx.getState();
        const v = validateDispense(raw, { compartments: st.compartments, allergens: st.allergens });
        if (!v.ok) return { ok: false, error: v.error, warnings: v.warnings };
        await ctx.dispense(v.steps);
        return { ok: true, dispensed: v.steps, warnings: v.warnings };
      }
      case "save_mix": {
        const steps = (args.steps || []).map((s) => ({ slot: +s.compartment, dose_units: +s.dose_units }));
        await ctx.saveMix(args.name, steps);
        return { ok: true, saved: args.name };
      }
      case "set_preference": {
        const key = String(args.key || "").trim();
        if (!key) return { ok: false, error: "preference key required" };
        await ctx.setPreference(key, args.value == null ? "" : String(args.value).trim());
        return { ok: true, saved: key };
      }
      case "set_allergens": {
        const spices = [...new Set((args.spices || []).map((s) => String(s).toLowerCase().trim()).filter(Boolean))];
        await ctx.setAllergens(spices);
        return { ok: true, allergens: spices };
      }
      case "get_state":
        return { ok: true, ...ctx.getState() };
      default:
        return { ok: false, error: `unknown tool ${name}` };
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

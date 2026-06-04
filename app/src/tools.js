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
];

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
        const steps = (args.steps || [])
          .filter((s) => s && s.compartment && s.dose_units > 0)
          .map((s) => ({ slot: +s.compartment, dose_units: +s.dose_units }));
        if (!steps.length) return { ok: false, error: "no valid steps" };
        await ctx.dispense(steps);
        return { ok: true, dispensed: steps };
      }
      case "save_mix": {
        const steps = (args.steps || []).map((s) => ({ slot: +s.compartment, dose_units: +s.dose_units }));
        await ctx.saveMix(args.name, steps);
        return { ok: true, saved: args.name };
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

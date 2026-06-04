import { describe, it, expect } from "vitest";
import { PERSONAS, DEFAULT_PERSONA_ID, getPersona, personaSystemPrompt } from "./personas.js";

describe("personas", () => {
  it("every persona has the fields the app relies on", () => {
    for (const p of PERSONAS) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.emoji).toBeTruthy();
      expect(p.prompt).toBeTruthy();
      expect(p.eleven).toMatch(/^[A-Za-z0-9]+$/); // ElevenLabs voice id
      expect(p.rtVoice).toBeTruthy();             // OpenAI realtime preset
    }
  });

  it("ids are unique", () => {
    const ids = PERSONAS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the default persona exists", () => {
    expect(getPersona(DEFAULT_PERSONA_ID)).toBeTruthy();
  });

  it("getPersona falls back to the default for an unknown id", () => {
    expect(getPersona("nope").id).toBe(DEFAULT_PERSONA_ID);
  });

  it("personaSystemPrompt keeps the functional rules and adds the character", () => {
    const base = "BASE RULES: dispense on request.";
    const out = personaSystemPrompt(getPersona("ramsay"), base);
    expect(out).toContain(base);            // functional rules preserved verbatim
    expect(out.toLowerCase()).toContain("chef"); // character flavour present
    expect(out.indexOf("CHARACTER")).toBeLessThan(out.indexOf(base)); // flavour first, rules after
  });

  it("personaSystemPrompt returns the base unchanged when no persona", () => {
    expect(personaSystemPrompt(null, "BASE")).toBe("BASE");
  });
});

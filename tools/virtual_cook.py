#!/usr/bin/env python3
"""Drive a full conversation through the REAL DeepInfra brain and dispense to
Supabase — exactly what the phone app does, minus the mic/speaker. Pair with
mock_device.py (the virtual dispenser) to test the whole pipeline.

Usage:  python3 tools/virtual_cook.py "I'm making chili for four, medium spicy"
"""
import json, sys, time, urllib.request, urllib.error, pathlib

ENV = pathlib.Path(__file__).resolve().parent.parent / ".env"
cfg = {}
for line in ENV.read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); cfg[k] = v

URL = cfg["SUPABASE_PROJECT_URL"].rstrip("/")
ANON = cfg["SUPABASE_ANON_KEY"]
DI_KEY = cfg["DEEPINFRA_API_KEY"]
MODEL = "meta-llama/Meta-Llama-3.1-8B-Instruct"
DEVICE = "dispenser-01"
SB_H = {"apikey": ANON, "Authorization": f"Bearer {ANON}", "Content-Type": "application/json"}


def post(url, body, headers):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req) as r:
        txt = r.read().decode()
        return json.loads(txt) if txt.strip() else None


def get_slots():
    req = urllib.request.Request(f"{URL}/rest/v1/devices?device_id=eq.{DEVICE}&select=slots", headers=SB_H)
    with urllib.request.urlopen(req) as r:
        rows = json.loads(r.read().decode())
    return rows[0]["slots"] if rows else {}


def get_recipes():
    req = urllib.request.Request(f"{URL}/rest/v1/recipes?select=name,steps", headers=SB_H)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())


def system_prompt(slots, recipes):
    sl = ", ".join(f"slot {s}={n}" for s, n in sorted(slots.items(), key=lambda x: int(x[0]))) or "(none)"
    rc = "; ".join(f'"{r["name"]}": {json.dumps(r["steps"])}' for r in recipes) or "(none yet)"
    return (
        "You are the voice brain of a smart spice dispenser, mid-conversation with a cook. "
        f"Spice slots: {sl}. A dose_unit is one sweep of the dispense servo (a pinch); there is no scale. "
        f"Saved recipes: {rc}. "
        "Speak briefly. Ask ONE clarifying question at a time, then decide spices+amounts. "
        "Only use slots that exist. If asked to 'make <recipe>', use that recipe's steps. "
        "You MAY save a good mix via save_recipe. "
        'ALWAYS reply with ONE JSON object: {"say":"<spoken>","done":<bool>,'
        '"plan":[{"slot":<int>,"dose_units":<int>}],"save_recipe":null|{"name":"...","steps":[...]}}. '
        "While gathering info done=false plan=[]. When dispensing done=true with plan."
    )


def llm(messages):
    r = post("https://api.deepinfra.com/v1/openai/chat/completions",
             {"model": MODEL, "temperature": 0.4, "response_format": {"type": "json_object"},
              "messages": messages},
             {"Authorization": f"Bearer {DI_KEY}", "Content-Type": "application/json"})
    content = r["choices"][0]["message"]["content"]
    try:
        return json.loads(content)
    except Exception:
        import re
        m = re.search(r"\{[\s\S]*\}", content)
        return json.loads(m.group(0)) if m else {"say": content, "done": False, "plan": []}


def dispense(plan, slots):
    rows = [{"device_id": DEVICE, "type": "dispense",
             "payload": {"slot": int(p["slot"]), "dose_units": int(p["dose_units"])}}
            for p in plan if p.get("dose_units", 0) > 0]
    if rows:
        post(f"{URL}/rest/v1/commands", rows, SB_H)
        print("   → queued:", ", ".join(f'{slots.get(str(r["payload"]["slot"]), r["payload"]["slot"])} x{r["payload"]["dose_units"]}' for r in rows))


def save_recipe(rec):
    post(f"{URL}/rest/v1/recipes", [{"name": rec["name"], "steps": rec["steps"]}], SB_H)
    print(f"   📖 saved recipe: {rec['name']}")


def main():
    slots = get_slots()
    recipes = get_recipes()
    print(f"slots: {slots}\nrecipes: {[r['name'] for r in recipes]}\n")
    msgs = [{"role": "system", "content": system_prompt(slots, recipes)}]
    # cook's opening line (from CLI) then nudges until the brain dispenses
    cook_lines = [sys.argv[1] if len(sys.argv) > 1 else "I'm making chili for four, medium spicy."]
    nudges = ["Sounds good, go ahead and dispense.", "Yes, do it now.", "Just pick sensible amounts and dispense."]

    turn = 0
    while turn < 6:
        user = cook_lines.pop(0) if cook_lines else nudges[min(turn, len(nudges) - 1)]
        print(f"🧑 cook: {user}")
        msgs.append({"role": "user", "content": user})
        res = llm(msgs)
        msgs.append({"role": "assistant", "content": json.dumps(res)})
        print(f"🤖 dispenser: {res.get('say')}")
        if res.get("save_recipe"):
            save_recipe(res["save_recipe"])
        if res.get("done") and res.get("plan"):
            dispense(res["plan"], slots)
            print("\n✓ conversation reached a dispense.")
            return
        turn += 1
    print("\n(no dispense after 6 turns)")


if __name__ == "__main__":
    main()

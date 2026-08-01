"""
PIT//CALL orchestrator — manual Gemma tool-calling loop.

Spur's Gemma 3 27B deployment doesn't have vLLM's native OpenAI tool-calling
enabled (--enable-auto-tool-choice / --tool-call-parser aren't set upstream),
so this implements the "Decide" pillar as a two-pass structured-JSON
protocol instead of the native `tools=` API:

  Pass 1 (SENSE/PREDICT selection): Gemma reads the latest telemetry and the
  available tool schemas, and returns which deterministic tools to call.
  Pass 2 (DECIDE/EXPLAIN): Gemma reads the tool results and returns one
  explainable recommendation: a <=30-word call, confidence, evidence,
  and the rejected alternative.

Run:
    python3 orchestrator.py scenarios/degradation.csv
"""

import csv
import json
import os
import sys
import time

from dotenv import load_dotenv
from openai import OpenAI

from tools import TOOL_FUNCTIONS, TOOL_SCHEMAS

load_dotenv()

API_KEY = os.environ.get("SPUR_API_KEY")
BASE_URL = os.environ.get("SPUR_BASE_URL", "https://ai.spuric.com/v1")
MODEL = "spur-gemma"

TOOL_SELECT_PROMPT = """You are PIT//CALL's decision layer for a Formula 1 race strategist. \
You have these deterministic analytical tools available:

{tools}

You will be given the last few laps of telemetry as JSON. Decide which \
tool(s) are needed to make a pit-stop recommendation, and with what \
arguments — pick based on what's actually happening in the data (tire \
wear trend, traffic/gaps, track status), not a fixed checklist. Respond \
with ONLY a JSON object, no prose:

{{"tool_calls": [{{"tool": "<name>", "args": {{...}}}}, ...]}}"""

FINAL_DECISION_PROMPT = """You are PIT//CALL, a Formula 1 crew-chief co-pilot. \
You already ran analytical tools; their results are below along with the \
raw telemetry. Respond with ONLY a JSON object, no prose:

{{
  "call": "<=30 words. One clear instruction: BOX, STAY OUT, MANAGE TYRES, or LIFT & COAST, plus the key reason.",
  "confidence_pct": <0-100 integer>,
  "evidence": ["short fact from tool output", "..."],
  "regulation_citation": "if check_regulations results are present, the article number + one clause it establishes (e.g. 'B5.13.3: pitting for tyres is permitted under SC'); else null",
  "alternative_considered": "the option NOT chosen, and why it lost"
}}"""


def load_scenario(csv_path: str) -> list[dict]:
    laps = []
    with open(csv_path) as f:
        for row in csv.DictReader(f):
            laps.append(
                {
                    "lap": int(row["lap"]),
                    "total_laps": int(row["total_laps"]),
                    "driver": row["driver"],
                    "gap_ahead_sec": float(row["gap_ahead_sec"]),
                    "gap_behind_sec": float(row["gap_behind_sec"]),
                    "tire_compound": row["tire_compound"],
                    "tire_age_laps": int(row["tire_age_laps"]),
                    "tire_wear_pct": {
                        "FL": float(row["fl_wear"]),
                        "FR": float(row["fr_wear"]),
                        "RL": float(row["rl_wear"]),
                        "RR": float(row["rr_wear"]),
                    },
                    "tire_temps_c": {
                        "FL": float(row["fl_temp"]),
                        "FR": float(row["fr_temp"]),
                        "RL": float(row["rl_temp"]),
                        "RR": float(row["rr_temp"]),
                    },
                    "brake_temp_c": float(row["brake_temp_c"]),
                    "energy_pct": float(row["energy_pct"]),
                    "engine_temp_c": float(row["engine_temp_c"]),
                    "fuel_kg": float(row["fuel_kg"]),
                    "lap_time_sec": float(row["lap_time_sec"]),
                    "track_status": row["track_status"],
                }
            )
    return laps


def call_gemma(client: OpenAI, system: str, user_content: str) -> str:
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_content},
        ],
        temperature=0.2,
    )
    return strip_code_fence(response.choices[0].message.content or "")


def strip_code_fence(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text.rsplit("```", 1)[0]
        text = text.strip()
        if text.startswith("json"):
            text = text[4:].strip()
    return text


_client = None


def get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=API_KEY, base_url=BASE_URL)
    return _client


def decide(
    recent_laps: list[dict], total_laps: int, client: OpenAI | None = None
) -> dict:
    """Run the full Sense/Predict -> Decide -> Explain loop over a window of laps.

    Returns a dict with the tool selection, executed tool results, final
    decision, and measured latency — used by both the CLI and the web API.
    """
    client = client or get_client()
    t0 = time.time()

    tool_select_system = TOOL_SELECT_PROMPT.format(
        tools=json.dumps(TOOL_SCHEMAS, indent=2)
    )
    selection_raw = call_gemma(client, tool_select_system, json.dumps(recent_laps))

    try:
        selection = json.loads(selection_raw)
    except json.JSONDecodeError:
        return {"error": "Could not parse tool selection JSON", "raw": selection_raw}

    tool_calls = []
    tool_results = {}
    for call in selection.get("tool_calls", []):
        name = call.get("tool")
        args = call.get("args", {})
        fn = TOOL_FUNCTIONS.get(name)
        if not fn:
            continue
        if name in ("compare_pit_windows", "safety_car_pit_value"):
            args.setdefault("total_laps", total_laps)
        result = fn(recent_laps, **args)
        tool_results[name] = result
        tool_calls.append({"tool": name, "args": args, "result": result})

    decision_context = {"latest_lap": recent_laps[-1], "tool_results": tool_results}
    decision_raw = call_gemma(
        client, FINAL_DECISION_PROMPT, json.dumps(decision_context)
    )
    elapsed = time.time() - t0

    try:
        decision = json.loads(decision_raw)
    except json.JSONDecodeError:
        decision = {"error": "Could not parse final decision JSON", "raw": decision_raw}

    return {
        "latest_lap": recent_laps[-1],
        "tool_calls": tool_calls,
        "decision": decision,
        "elapsed_sec": round(elapsed, 2),
    }


def run(csv_path: str, window: int = 5):
    laps = load_scenario(csv_path)
    recent_laps = laps[-window:]
    total_laps = laps[-1]["total_laps"]

    result = decide(recent_laps, total_laps)

    if "error" in result:
        print(result["error"], file=sys.stderr)
        print(result.get("raw", ""), file=sys.stderr)
        sys.exit(1)

    print("=== Tool-call trace ===")
    for call in result["tool_calls"]:
        print(f"  -> {call['tool']}({call['args']}) = {json.dumps(call['result'])}")

    print("\n=== PIT//CALL decision ===")
    print(json.dumps(result["decision"], indent=2))

    if "call" in result["decision"]:
        word_count = len(result["decision"]["call"].split())
        print(f"\nDecision word count: {word_count} (target: <=30)")

    print(f"\nTotal latency: {result['elapsed_sec']}s (target: <2s)")


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "scenarios/degradation.csv"
    run(path)

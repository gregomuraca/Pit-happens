"""
PIT//CALL web backend.

Serves the dashboard and exposes the scenario/decision API. Each
scenario is replayed lap by lap: the frontend asks for a window ending
at a given lap, and this calls straight into orchestrator.decide() —
the same Sense -> Predict -> Decide -> Explain loop as the CLI.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from orchestrator import decide, load_scenario

app = FastAPI(title="PIT//CALL")

SCENARIOS_DIR = os.path.join(os.path.dirname(__file__), "..", "scenarios")

# Flavor metadata not present in the raw telemetry — presented as scenario
# context, not derived from the physics data itself.
SCENARIO_META = {
    "degradation": {
        "label": "Tyre Degradation",
        "track": "Monza",
        "session": "Race",
        "weather": {"track_c": 41, "air_c": 27, "condition": "Dry", "wind_kmh": 9},
        "pit_stop_loss_sec": 22.0,
    },
    "traffic": {
        "label": "Traffic / Defend",
        "track": "Silverstone",
        "session": "Race",
        "weather": {"track_c": 32, "air_c": 21, "condition": "Overcast", "wind_kmh": 18},
        "pit_stop_loss_sec": 22.0,
    },
    "safety_car": {
        "label": "Safety Car Window",
        "track": "Spa-Francorchamps",
        "session": "Race",
        "weather": {"track_c": 24, "air_c": 18, "condition": "Damp", "wind_kmh": 14},
        "pit_stop_loss_sec": 22.0,
    },
    "thermal": {
        "label": "Thermal Risk",
        "track": "Singapore",
        "session": "Race",
        "weather": {"track_c": 45, "air_c": 31, "condition": "Humid", "wind_kmh": 5},
        "pit_stop_loss_sec": 24.0,
    },
}

WINDOW = 5


@app.get("/api/scenarios")
def list_scenarios():
    out = []
    for name, meta in SCENARIO_META.items():
        laps = load_scenario(os.path.join(SCENARIOS_DIR, f"{name}.csv"))
        out.append(
            {
                "id": name,
                **meta,
                "first_lap": laps[0]["lap"],
                "last_lap": laps[-1]["lap"],
                "total_laps": laps[-1]["total_laps"],
            }
        )
    return out


@app.get("/api/scenario/{name}/lap/{lap}")
def get_decision(name: str, lap: int):
    if name not in SCENARIO_META:
        raise HTTPException(404, f"Unknown scenario: {name}")

    laps = load_scenario(os.path.join(SCENARIOS_DIR, f"{name}.csv"))
    idx = next((i for i, l in enumerate(laps) if l["lap"] == lap), None)
    if idx is None:
        raise HTTPException(404, f"No lap {lap} in scenario {name}")

    window = laps[max(0, idx - WINDOW + 1) : idx + 1]
    total_laps = laps[-1]["total_laps"]

    result = decide(window, total_laps)
    result["meta"] = {**SCENARIO_META[name], "id": name}
    result["progress"] = {
        "current_lap": lap,
        "first_lap": laps[0]["lap"],
        "last_lap": laps[-1]["lap"],
        "total_laps": total_laps,
    }
    return result


static_dir = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=static_dir), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(static_dir, "index.html"))

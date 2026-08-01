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

import openf1_source as ofs
from orchestrator import decide, load_scenario

app = FastAPI(title="PIT//CALL")

SCENARIOS_DIR = os.path.join(os.path.dirname(__file__), "..", "scenarios")
REAL_SCENARIO_ID = "belgian_gp_2026"

# Flavor metadata not present in the raw telemetry — presented as scenario
# context, not derived from the physics data itself.
SCENARIO_META = {
    "degradation": {
        "label": "Tyre Degradation",
        "track": "Monza",
        "session": "Race",
        "weather": {"track_c": 41, "air_c": 27, "condition": "Dry", "wind_kmh": 9},
        "pit_stop_loss_sec": 22.0,
        "is_real": False,
    },
    "traffic": {
        "label": "Traffic / Defend",
        "track": "Silverstone",
        "session": "Race",
        "weather": {"track_c": 32, "air_c": 21, "condition": "Overcast", "wind_kmh": 18},
        "pit_stop_loss_sec": 22.0,
        "is_real": False,
    },
    "safety_car": {
        "label": "Safety Car Window",
        "track": "Spa-Francorchamps",
        "session": "Race",
        "weather": {"track_c": 24, "air_c": 18, "condition": "Damp", "wind_kmh": 14},
        "pit_stop_loss_sec": 22.0,
        "is_real": False,
    },
    "thermal": {
        "label": "Thermal Risk",
        "track": "Singapore",
        "session": "Race",
        "weather": {"track_c": 45, "air_c": 31, "condition": "Humid", "wind_kmh": 5},
        "pit_stop_loss_sec": 24.0,
        "is_real": False,
    },
    REAL_SCENARIO_ID: {
        "label": "Belgian GP 2026 (Real)",
        "track": "Spa-Francorchamps",
        "session": "Race",
        "weather": {"track_c": 0, "air_c": 0, "condition": "—", "wind_kmh": 0},  # overridden per-lap below
        "pit_stop_loss_sec": 24.0,
        "is_real": True,
        "data_note": "Real OpenF1 data (laps, gaps, positions, weather, race control). Tire wear/temp, brakes, ERS, and fuel have no public source and are estimated — see estimated_fields per lap.",
    },
}

WINDOW = 5
REAL_FIRST_LAP, REAL_LAST_LAP = 1, 8  # covers real green -> real safety car -> real green


@app.get("/api/scenarios")
def list_scenarios():
    out = []
    for name, meta in SCENARIO_META.items():
        if name == REAL_SCENARIO_ID:
            out.append(
                {
                    "id": name,
                    **meta,
                    "first_lap": REAL_FIRST_LAP,
                    "last_lap": REAL_LAST_LAP,
                    "total_laps": ofs.TOTAL_LAPS,
                }
            )
            continue
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

    if name == REAL_SCENARIO_ID:
        if not (REAL_FIRST_LAP <= lap <= REAL_LAST_LAP):
            raise HTTPException(404, f"No lap {lap} in scenario {name}")
        window = [ofs.get_real_lap(n) for n in range(max(REAL_FIRST_LAP, lap - WINDOW + 1), lap + 1)]
        total_laps = ofs.TOTAL_LAPS
        result = decide(window, total_laps)
        result["meta"] = {**SCENARIO_META[name], "id": name, "weather": window[-1]["weather"]}
        result["standings"] = ofs.get_real_field_snapshot(ofs.get_real_lap_datetime(lap))
        result["progress"] = {
            "current_lap": lap, "first_lap": REAL_FIRST_LAP, "last_lap": REAL_LAST_LAP, "total_laps": total_laps,
        }
        return result

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

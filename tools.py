"""
PIT//CALL deterministic analytics tools.

These are the "Sense" and "Predict" pillars: reliable, non-LLM
calculations over lap-by-lap telemetry. Gemma (the "Decide" pillar)
chooses which of these to call and interprets their output — it never
does the arithmetic itself. check_regulations is the one retrieval-based
exception: it uses spur-embed (Nomic Embed) for semantic search, not
Gemma, over real FIA regulation excerpts — still not a generative call.
"""

from __future__ import annotations

import json
import os

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

_rag_index = None
_embed_client = None


def estimate_degradation(laps: list[dict], tire_key: str = "FL") -> dict:
    """Fit a simple linear wear trend and project the lap wear hits a cliff.

    A "cliff" is treated as 85% wear on the given corner, past which grip
    drops off sharply. Uses the last 3 laps of wear data (or fewer if
    that's all there is) to estimate laps-per-percent.
    """
    wear_points = [
        (lap["lap"], lap["tire_wear_pct"][tire_key]) for lap in laps if "tire_wear_pct" in lap
    ]
    if len(wear_points) < 2:
        return {"error": "need at least 2 laps of wear data"}

    recent = wear_points[-3:]
    lap_span = recent[-1][0] - recent[0][0]
    wear_span = recent[-1][1] - recent[0][1]
    wear_rate_pct_per_lap = wear_span / lap_span if lap_span else 0

    current_lap, current_wear = wear_points[-1]
    CLIFF_WEAR_PCT = 85
    laps_to_cliff = None
    if wear_rate_pct_per_lap > 0:
        laps_to_cliff = round((CLIFF_WEAR_PCT - current_wear) / wear_rate_pct_per_lap, 1)

    return {
        "tire": tire_key,
        "current_lap": current_lap,
        "current_wear_pct": current_wear,
        "wear_rate_pct_per_lap": round(wear_rate_pct_per_lap, 2),
        "projected_laps_to_cliff": laps_to_cliff,
        "cliff_imminent": laps_to_cliff is not None and laps_to_cliff <= 2,
    }


def pace_trend(laps: list[dict]) -> dict:
    """Trend of the last lap times: are we getting faster or slower, and how fast."""
    times = [lap["lap_time_sec"] for lap in laps if "lap_time_sec" in lap]
    if len(times) < 2:
        return {"error": "need at least 2 laps of lap-time data"}
    delta_per_lap = (times[-1] - times[0]) / (len(times) - 1)
    return {
        "laps_considered": len(times),
        "delta_sec_per_lap": round(delta_per_lap, 3),
        "trend": "degrading" if delta_per_lap > 0.05 else ("improving" if delta_per_lap < -0.05 else "stable"),
        "last_lap_time_sec": times[-1],
    }


def compare_pit_windows(
    laps: list[dict],
    total_laps: int,
    pit_stop_loss_sec: float = 22.0,
    fresh_tire_pace_gain_sec: float = 0.6,
) -> dict:
    """Numerically compare pitting now vs. staying out for the rest of the current stint horizon.

    Simplified deterministic model:
    - Staying out costs the projected degradation delta per remaining lap
      (using the current wear_rate trend converted to a pace penalty).
    - Pitting now costs a fixed pit-stop loss but resets pace to fresh-tire
      levels (fresh_tire_pace_gain_sec faster per lap vs. current degraded pace).
    """
    deg = estimate_degradation(laps)
    pace = pace_trend(laps)
    if "error" in deg or "error" in pace:
        return {"error": "insufficient telemetry for pit-window comparison"}

    current_lap = laps[-1]["lap"]
    remaining_laps = max(total_laps - current_lap, 1)
    horizon = min(remaining_laps, 10)  # compare over the next 10 laps or to race end

    # Approximate pace penalty per lap from degradation rate (rough heuristic:
    # every 5% extra wear costs ~0.15s/lap of pace).
    pace_penalty_per_lap = max(deg["wear_rate_pct_per_lap"], 0) * 0.03

    stay_out_cost_sec = sum(pace_penalty_per_lap * i for i in range(1, horizon + 1))
    pit_now_cost_sec = pit_stop_loss_sec - (fresh_tire_pace_gain_sec * horizon)

    return {
        "horizon_laps": horizon,
        "stay_out_projected_cost_sec": round(stay_out_cost_sec, 2),
        "pit_now_projected_cost_sec": round(pit_now_cost_sec, 2),
        "recommendation_by_numbers": "pit_now" if pit_now_cost_sec < stay_out_cost_sec else "stay_out",
        "margin_sec": round(abs(stay_out_cost_sec - pit_now_cost_sec), 2),
    }


def assess_thermal_risk(laps: list[dict], redline_c: float = 125.0) -> dict:
    """Trend power-unit temperature and flag if it's heading into the
    protection-mode redline, plus a lift-and-coast cost estimate.

    Lift-and-coast is modeled as costing ~0.15s/lap of pace per intervention
    lap, in exchange for an assumed ~2C/lap of cooling while applied.
    """
    temps = [lap["engine_temp_c"] for lap in laps if "engine_temp_c" in lap]
    if len(temps) < 2:
        return {"error": "need at least 2 laps of power-unit temp data"}

    delta_per_lap = (temps[-1] - temps[0]) / (len(temps) - 1)
    current = temps[-1]
    laps_to_redline = round((redline_c - current) / delta_per_lap, 1) if delta_per_lap > 0 else None

    LIFT_COOLING_PER_LAP_C = 2.0
    LIFT_COST_SEC_PER_LAP = 0.15
    laps_needed = None
    if delta_per_lap > 0:
        if current >= redline_c:
            # Already past redline: needs enough laps to cool back under it, plus margin.
            laps_needed = max(2, round((current - redline_c) / LIFT_COOLING_PER_LAP_C + 2))
        else:
            margin = redline_c - current
            laps_needed = max(1, round(margin / LIFT_COOLING_PER_LAP_C + 1))

    return {
        "current_temp_c": current,
        "delta_c_per_lap": round(delta_per_lap, 2),
        "redline_c": redline_c,
        "projected_laps_to_redline": laps_to_redline,
        "in_protection_risk": laps_to_redline is not None and laps_to_redline <= 3,
        "lift_and_coast_laps_recommended": laps_needed,
        "lift_and_coast_cost_sec_per_lap": LIFT_COST_SEC_PER_LAP if laps_needed else None,
    }


def assess_traffic_risk(laps: list[dict]) -> dict:
    """Trend the gap to the car ahead/behind to flag overtake or defend risk.

    DRS range is treated as under 1.0s. A gap closing at more than
    0.05s/lap is flagged as a live threat/opportunity.
    """
    gaps_ahead = [lap["gap_ahead_sec"] for lap in laps if "gap_ahead_sec" in lap]
    gaps_behind = [lap["gap_behind_sec"] for lap in laps if "gap_behind_sec" in lap]
    if len(gaps_ahead) < 2 or len(gaps_behind) < 2:
        return {"error": "need at least 2 laps of gap data"}

    ahead_delta_per_lap = (gaps_ahead[-1] - gaps_ahead[0]) / (len(gaps_ahead) - 1)
    behind_delta_per_lap = (gaps_behind[-1] - gaps_behind[0]) / (len(gaps_behind) - 1)

    return {
        "gap_ahead_sec": gaps_ahead[-1],
        "gap_ahead_trend": "closing" if ahead_delta_per_lap < -0.05 else ("opening" if ahead_delta_per_lap > 0.05 else "stable"),
        "drs_range_ahead": gaps_ahead[-1] < 1.0,
        "gap_behind_sec": gaps_behind[-1],
        "gap_behind_trend": "closing" if behind_delta_per_lap < -0.05 else ("opening" if behind_delta_per_lap > 0.05 else "stable"),
        "under_attack": gaps_behind[-1] < 1.0 and behind_delta_per_lap < -0.05,
    }


def safety_car_pit_value(
    laps: list[dict],
    total_laps: int,
    normal_pit_stop_loss_sec: float = 22.0,
    safety_car_pit_stop_loss_sec: float = 9.0,
) -> dict:
    """Under safety car/VSC the field bunches up, so the effective cost of
    pitting drops sharply. Flags whether the current lap is a rare cheap
    pit-stop opportunity.
    """
    current = laps[-1]
    is_caution = current.get("track_status") in ("safety_car", "vsc", "yellow")
    saved_sec = normal_pit_stop_loss_sec - safety_car_pit_stop_loss_sec if is_caution else 0
    return {
        "track_status": current.get("track_status"),
        "is_caution_period": is_caution,
        "normal_pit_stop_loss_sec": normal_pit_stop_loss_sec,
        "effective_pit_stop_loss_sec": safety_car_pit_stop_loss_sec if is_caution else normal_pit_stop_loss_sec,
        "sec_saved_vs_normal_pit": saved_sec,
        "rare_opportunity": is_caution and saved_sec > 0,
    }


def _get_embed_client() -> OpenAI:
    global _embed_client
    if _embed_client is None:
        _embed_client = OpenAI(
            api_key=os.environ.get("SPUR_API_KEY"),
            base_url=os.environ.get("SPUR_BASE_URL", "https://ai.spuric.com/v1"),
        )
    return _embed_client


def _load_rag_index() -> list[dict]:
    global _rag_index
    if _rag_index is None:
        path = os.path.join(os.path.dirname(__file__), "rag", "index.json")
        with open(path) as f:
            _rag_index = json.load(f)
    return _rag_index


def _cosine(a: list[float], b: list[float]) -> float:
    import numpy as np

    a_arr, b_arr = np.array(a), np.array(b)
    return float(np.dot(a_arr, b_arr) / (np.linalg.norm(a_arr) * np.linalg.norm(b_arr)))


def check_regulations(laps: list[dict], query: str, top_k: int = 2) -> dict:
    """Semantic search over real FIA 2026 Sporting Regulations excerpts
    (Safety Car / VSC / pit lane articles) so a call can cite actual rule
    text instead of just computed numbers. `laps` is unused — kept for a
    consistent tool-calling signature with the other tools.
    """
    index = _load_rag_index()
    client = _get_embed_client()
    q_embedding = client.embeddings.create(model="spur-embed", input=[query]).data[0].embedding
    scored = sorted(index, key=lambda c: _cosine(c["embedding"], q_embedding), reverse=True)
    return {
        "query": query,
        "results": [
            {"article": c["article"], "title": c["title"], "text": c["text"]}
            for c in scored[:top_k]
        ],
    }


TOOL_SCHEMAS = {
    "estimate_degradation": {
        "description": "Fit tire wear trend and project laps remaining until the tire hits its performance cliff.",
        "args": {"tire_key": "one of FL, FR, RL, RR (default FL)"},
    },
    "pace_trend": {
        "description": "Check whether lap times are degrading, stable, or improving, and by how much per lap.",
        "args": {},
    },
    "compare_pit_windows": {
        "description": "Numerically compare the cost (in seconds) of pitting now vs. staying out.",
        "args": {"total_laps": "int, total race distance"},
    },
    "assess_traffic_risk": {
        "description": "Trend the gap to cars ahead/behind to flag overtake opportunity or defend-under-attack risk.",
        "args": {},
    },
    "safety_car_pit_value": {
        "description": "Check whether the current lap is a caution period (safety car/VSC/yellow) making a pit stop unusually cheap.",
        "args": {"total_laps": "int, total race distance"},
    },
    "check_regulations": {
        "description": "Look up the actual FIA rule text before advising a pit stop during any non-green track_status (safety_car, vsc, yellow). Confirms whether pitting is currently legal/required and what penalty applies if not, and lets the final call cite a real article instead of just tool numbers. Always call this when track_status is not green.",
        "args": {"query": "short search phrase, e.g. 'pit lane access during safety car'"},
    },
    "assess_thermal_risk": {
        "description": "Trend power-unit temperature to flag if it's heading into the protection-mode redline, and estimate a lift-and-coast intervention if needed.",
        "args": {"redline_c": "float, protection-mode threshold (default 125.0)"},
    },
}

TOOL_FUNCTIONS = {
    "estimate_degradation": estimate_degradation,
    "pace_trend": pace_trend,
    "compare_pit_windows": compare_pit_windows,
    "assess_traffic_risk": assess_traffic_risk,
    "safety_car_pit_value": safety_car_pit_value,
    "check_regulations": check_regulations,
    "assess_thermal_risk": assess_thermal_risk,
}

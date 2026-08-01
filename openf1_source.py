"""
Real F1 telemetry via OpenF1 (api.openf1.org) — a modern, open,
unauthenticated API for live and historical F1 session data. Unlike
FastF1's underlying livetiming.formula1.com host (blocked by CloudFront
for datacenter IPs — see PLANNING.md), OpenF1 is reachable and serves
real session data for actual 2026 Grands Prix.

What's genuinely real here: lap times, gaps/intervals to other cars,
race positions, tire compound + stint age, track status (from real race
control flag messages), weather, and driver identity.

What's NOT public anywhere (not even TV broadcasts show it): tire wear %,
tire/brake temperatures, ERS energy, fuel load. Those are proprietary team
telemetry. Rather than inventing precise numbers for them, this module
computes them from documented, physically-motivated estimates and tags
which fields on each lap record are estimated vs. real — see
ESTIMATED_FIELDS on each returned lap.

Session used: 2026 Belgian Grand Prix, Race, session_key=11334 — chosen
because it has a real safety car period (laps 2-4) and a real pit stop,
matching the shape of our synthetic scenarios but with genuine data.
"""

import json
import os
import subprocess
import urllib.parse
from datetime import datetime

BASE = "https://api.openf1.org/v1"
CACHE_DIR = os.path.join(os.path.dirname(__file__), ".openf1_cache")

SESSION_KEY = 11334  # 2026 Belgian GP, Race
DRIVER_NUMBER = 44  # Hamilton — real safety car + real pit stop in this session
TOTAL_LAPS = 44

ESTIMATED_FIELDS = ["tire_wear_pct", "tire_temps_c", "brake_temp_c", "energy_pct", "fuel_kg", "engine_temp_c"]

# Rough per-lap wear-rate by compound (%/lap), used only to derive the
# ESTIMATED tire_wear_pct from real tyre_age_laps — not a measurement.
WEAR_RATE_BY_COMPOUND = {"SOFT": 3.2, "MEDIUM": 2.2, "HARD": 1.5, "INTERMEDIATE": 2.0, "WET": 1.8}


def _fetch(endpoint: str, **params) -> list:
    os.makedirs(CACHE_DIR, exist_ok=True)
    key = endpoint.replace("/", "_") + "__" + "_".join(f"{k}={v}" for k, v in sorted(params.items()))
    cache_path = os.path.join(CACHE_DIR, key + ".json")
    if os.path.exists(cache_path):
        with open(cache_path) as f:
            return json.load(f)
    url = f"{BASE}/{endpoint}?" + urllib.parse.urlencode(params)
    result = subprocess.run(["curl", "-s", "--max-time", "20", url], capture_output=True, text=True, check=True)
    data = json.loads(result.stdout)
    with open(cache_path, "w") as f:
        json.dump(data, f)
    return data


def _parse_dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _nearest(records: list, dt: datetime, date_key: str = "date"):
    if not records:
        return None
    return min(records, key=lambda r: abs(_parse_dt(r[date_key]) - dt))


_session_cache = {}


def _load_session():
    if _session_cache:
        return _session_cache

    laps = sorted(
        [l for l in _fetch("laps", session_key=SESSION_KEY, driver_number=DRIVER_NUMBER) if l.get("lap_duration")],
        key=lambda l: l["lap_number"],
    )
    stints = _fetch("stints", session_key=SESSION_KEY, driver_number=DRIVER_NUMBER)
    weather = _fetch("weather", session_key=SESSION_KEY)
    race_control = _fetch("race_control", session_key=SESSION_KEY)
    driver_info = _fetch("drivers", session_key=SESSION_KEY, driver_number=DRIVER_NUMBER)
    our_intervals = _fetch("intervals", session_key=SESSION_KEY, driver_number=DRIVER_NUMBER)
    our_position = _fetch("position", session_key=SESSION_KEY, driver_number=DRIVER_NUMBER)
    all_intervals = _fetch("intervals", session_key=SESSION_KEY)
    all_positions = _fetch("position", session_key=SESSION_KEY)
    all_drivers = _fetch("drivers", session_key=SESSION_KEY)

    _session_cache.update(
        laps=laps, stints=stints, weather=weather, race_control=race_control,
        driver_info=driver_info[0] if driver_info else {"broadcast_name": f"CAR_{DRIVER_NUMBER}"},
        our_intervals=our_intervals, our_position=our_position,
        all_intervals=all_intervals, all_positions=all_positions, all_drivers=all_drivers,
    )
    return _session_cache


def _track_status_at(dt: datetime, race_control: list) -> str:
    active = "green"
    for m in sorted(race_control, key=lambda m: m["date"]):
        if _parse_dt(m["date"]) > dt:
            break
        msg = (m.get("message") or "").upper()
        if "SAFETY CAR DEPLOYED" in msg:
            active = "safety_car"
        elif "SAFETY CAR IN THIS LAP" in msg or "SAFETY CAR IN LAP" in msg:
            active = "green"
        elif "VSC DEPLOYED" in msg:
            active = "vsc"
        elif "VSC ENDING" in msg:
            active = "green"
    return active


def _tire_age_and_compound(lap_number: int, stints: list):
    for s in stints:
        if s["lap_start"] <= lap_number <= (s.get("lap_end") or 9999):
            age = s["tyre_age_at_start"] + (lap_number - s["lap_start"])
            return s["compound"], age
    return "UNKNOWN", 0


def get_real_lap_datetime(lap_number: int) -> datetime:
    s = _load_session()
    lap = next((l for l in s["laps"] if l["lap_number"] == lap_number), None)
    if lap is None:
        raise ValueError(f"No lap {lap_number} in session {SESSION_KEY}")
    return _parse_dt(lap["date_start"])


def get_real_lap(lap_number: int) -> dict:
    """One real lap for our tracked driver, OpenF1-backed with a few
    documented estimates for fields that have no public equivalent."""
    s = _load_session()
    lap = next((l for l in s["laps"] if l["lap_number"] == lap_number), None)
    if lap is None:
        raise ValueError(f"No lap {lap_number} in session {SESSION_KEY}")

    dt = _parse_dt(lap["date_start"])
    compound, tire_age = _tire_age_and_compound(lap_number, s["stints"])
    track_status = _track_status_at(dt, s["race_control"])

    our_interval = _nearest(s["our_intervals"], dt)
    gap_ahead_sec = our_interval["interval"] if our_interval and our_interval.get("interval") is not None else 0.0

    our_pos_rec = _nearest(s["our_position"], dt)
    our_position = our_pos_rec["position"] if our_pos_rec else None
    gap_behind_sec = 0.0
    if our_position is not None:
        behind_pos_rec = _nearest(
            [p for p in s["all_positions"] if p.get("position") == our_position + 1], dt
        )
        if behind_pos_rec:
            behind_interval = _nearest(
                [i for i in s["all_intervals"] if i["driver_number"] == behind_pos_rec["driver_number"]], dt
            )
            if behind_interval and behind_interval.get("interval") is not None:
                gap_behind_sec = behind_interval["interval"]

    wx = _nearest(s["weather"], dt) or {}

    wear_rate = WEAR_RATE_BY_COMPOUND.get(compound, 2.0)
    est_wear = min(round(tire_age * wear_rate, 1), 100.0)
    est_temp = round(85 + min(tire_age * 0.6, 35), 1)

    return {
        "lap": lap_number,
        "total_laps": TOTAL_LAPS,
        "driver": s["driver_info"].get("name_acronym") or f"CAR_{DRIVER_NUMBER}",
        "position": our_position,
        "gap_ahead_sec": round(gap_ahead_sec, 2),
        "gap_behind_sec": round(gap_behind_sec, 2),
        "tire_compound": compound.lower(),
        "tire_age_laps": tire_age,
        "tire_wear_pct": {k: est_wear for k in ("FL", "FR", "RL", "RR")},
        "tire_temps_c": {k: est_temp for k in ("FL", "FR", "RL", "RR")},
        "brake_temp_c": round(400 + min(tire_age * 8, 300), 1),
        "energy_pct": 65.0,
        "engine_temp_c": round(105 + min(lap_number * 0.3, 20), 1),
        "fuel_kg": round(max(110 - lap_number * 1.7, 5), 1),
        "lap_time_sec": round(lap["lap_duration"], 2),
        "track_status": track_status,
        "weather": {
            "track_c": round(wx.get("track_temperature", 0)),
            "air_c": round(wx.get("air_temperature", 0)),
            "condition": "Wet" if wx.get("rainfall") else "Dry",
            "wind_kmh": round(wx.get("wind_speed", 0) * 3.6, 1),
        },
        "estimated_fields": ESTIMATED_FIELDS,
    }


def get_real_field_snapshot(dt: datetime, limit: int = 20) -> list:
    """Real position + interval + driver name for the field near a given
    timestamp — backs the standings rail with genuine OpenF1 data."""
    s = _load_session()
    latest_pos_by_driver = {}
    for p in s["all_positions"]:
        if _parse_dt(p["date"]) <= dt:
            latest_pos_by_driver[p["driver_number"]] = p
    latest_int_by_driver = {}
    for i in s["all_intervals"]:
        if _parse_dt(i["date"]) <= dt:
            latest_int_by_driver[i["driver_number"]] = i
    names = {d["driver_number"]: d.get("name_acronym", f"CAR_{d['driver_number']}") for d in s["all_drivers"]}

    rows = sorted(latest_pos_by_driver.values(), key=lambda p: p["position"])[:limit]
    out = []
    for p in rows:
        num = p["driver_number"]
        interval = latest_int_by_driver.get(num, {})
        out.append(
            {
                "pos": p["position"],
                "car": names.get(num, f"CAR_{num}"),
                "gapToLeader": "LEADER" if p["position"] == 1 else f"+{interval.get('gap_to_leader', 0):.1f}s",
                "isUs": num == DRIVER_NUMBER,
            }
        )
    return out

"""
Pit Lane Telemetry — Gemma triage engine (MVP).

Sends a single telemetry snapshot to Gemma (via the Spur OpenAI-compatible
API) and gets back a structured race-strategy call: what to do, how
confident, and why. This is the core engine for the "Build With Gemma:
Triage In Light Speed" hackathon (Pit Lane Telemetry theme).

Setup:
    pip install -r requirements.txt
    # .env already has SPUR_API_KEY and SPUR_BASE_URL

Run:
    python gemma_triage.py
"""

import json
import os
import sys

from dotenv import load_dotenv
from openai import APIStatusError, OpenAI

load_dotenv()

API_KEY = os.environ.get("SPUR_API_KEY")
BASE_URL = os.environ.get("SPUR_BASE_URL", "https://ai.spuric.com/v1")

SYSTEM_PROMPT = """You are a Formula 1 race strategy engineer's co-pilot. \
You receive one telemetry snapshot for a car and must return ONLY a JSON \
object (no markdown, no prose outside the JSON) with this shape:

{
  "call": "one short imperative sentence, e.g. 'Box this lap for mediums'",
  "urgency": "low" | "medium" | "high" | "critical",
  "confidence_pct": <0-100 integer>,
  "reasoning": "2-3 sentences citing the specific data points that drove this call",
  "watch_next": "one short sentence on what to monitor next lap"
}

Base the call on tire wear/temp trends, gaps to cars ahead/behind, brake and \
engine thermals, pace trend over the last laps, and track status. Prioritize \
speed and clarity over hedging — a strategist has seconds, not minutes."""


def find_gemma_model(client: OpenAI) -> str:
    """Look through the account's available models for a Gemma variant."""
    models = client.models.list()
    ids = [m.id for m in models.data]
    gemma_ids = [m for m in ids if "gemma" in m.lower()]
    if not gemma_ids:
        print("No Gemma model found on this endpoint. Available models:", file=sys.stderr)
        for m in ids:
            print(f"  - {m}", file=sys.stderr)
        sys.exit(1)
    # Prefer a mid-size instruction-tuned variant if there's a choice.
    gemma_ids.sort()
    return gemma_ids[0]


def main():
    if not API_KEY:
        print("Missing SPUR_API_KEY in .env", file=sys.stderr)
        sys.exit(1)

    client = OpenAI(api_key=API_KEY, base_url=BASE_URL)

    print(f"Connecting to {BASE_URL} ...")
    try:
        model = find_gemma_model(client)
    except APIStatusError as e:
        if e.status_code == 402:
            print(
                "\nSpur account has no credit yet. Add funds at "
                "https://ai.spuric.com/account, then re-run this script.",
                file=sys.stderr,
            )
            sys.exit(1)
        raise
    print(f"Using model: {model}\n")

    with open("telemetry_sample.json") as f:
        telemetry = json.load(f)

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(telemetry)},
        ],
        temperature=0.2,
    )

    raw = response.choices[0].message.content
    print("--- Raw model output ---")
    print(raw)

    try:
        parsed = json.loads(raw)
        print("\n--- Parsed strategy call ---")
        print(json.dumps(parsed, indent=2))
    except json.JSONDecodeError:
        print("\n(Could not parse as JSON — model may need a stricter prompt or response_format.)")


if __name__ == "__main__":
    main()

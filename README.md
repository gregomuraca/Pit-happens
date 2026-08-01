# Pit Lane Telemetry — Build With Gemma Hackathon

MVP for the [Build With Gemma: Triage In Light Speed](https://www.kaggle.com/competitions/build-with-gemma-triage-in-light-speed/overview)
competition — Pit Lane Telemetry (F1 Strategy) theme. See `PLANNING.md` for
the project strategy (objective, users, vision, roadmap).

## Setup

```bash
pip install -r requirements.txt
```

Credentials already live in `.env` (gitignored):
- `SPUR_API_KEY` — Spur Compute API key
- `SPUR_BASE_URL` — `https://ai.spuric.com/v1` (OpenAI-compatible)

## Run

```bash
python3 gemma_triage.py
```

This sends the sample telemetry snapshot in `telemetry_sample.json` to
Gemma and prints back a structured strategy call (recommendation, urgency,
confidence, reasoning, what to watch next).

The script auto-discovers which model ID on the Spur account is a Gemma
variant. Confirmed working: `spur-gemma` = Google Gemma 3 27B
(multimodal-capable, 131K context) — this is what gets used.

## Submission requirements (Track: Pit Lane Telemetry)

Per the official rules, this repo is the required public fork of
[waterloodev/Build-With-Gemma](https://github.com/waterloodev/Build-With-Gemma)
(`LICENSE` kept as-is). To be eligible for judging we also need:

1. **Kaggle Writeup** — technical report: architecture, how Gemma was used, engineering hurdles, design choices
2. **Live Demo** — hosted Streamlit/Gradio app, terminal recording, or Kaggle Notebook judges can try
3. **This public repo** — well-documented, reproducible source

Scored out of 100: Gemma Integration (30), Innovation & Impact (30),
Functionality (20), Presentation & Writeup (20). Recommended approaches for
this track: function-calling agents, real-time predictive analytics,
conversational crew-chief interfaces.

## Status

- [x] Forked required template repo, kept `LICENSE`/`TRACKS.md` intact
- [x] Project scaffold + Spur API wiring
- [x] Core triage prompt (telemetry → structured strategy call)
- [x] Verified end-to-end against real Gemma 3 27B (`spur-gemma`)
- [ ] Live demo (Streamlit/Gradio/notebook) — not built yet
- [ ] Kaggle Writeup — not started
- [ ] Push current code to public fork

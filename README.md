# PIT//CALL — Build With Gemma Hackathon

F1 race-strategy co-pilot for the [Build With Gemma: Triage In Light Speed](https://www.kaggle.com/competitions/build-with-gemma-triage-in-light-speed/overview)
competition — Pit Lane Telemetry track. See `PLANNING.md` for the full
strategy (Power Strategy Framework: objective, users, benefit, power
hypothesis, barrier, pillars, roadmap).

Turns a lap-by-lap telemetry stream into one explainable pit-stop call —
**BOX**, **STAY OUT**, **MANAGE TYRES**, or **LIFT & COAST** — backed by
deterministic analytics and real FIA regulation text, synthesized by Gemma.
Neither the tools nor Gemma alone.

## Architecture

```
tools.py            Deterministic analytics (Sense/Predict) + RAG retrieval
orchestrator.py      Two-pass Gemma tool-orchestration loop (Decide/Explain)
rag/                 FIA 2026 Sporting Regulations corpus + spur-embed index
scenarios/           4 real lap-by-lap telemetry scenarios (CSV)
web/server.py         FastAPI wrapper exposing orchestrator.decide() as JSON
web/static/            Vanilla JS/HTML dashboard (first working demo)
frontend/            Next.js dashboard (production UI) — Route Handlers proxy
                     to web/server.py so the Spur API key never reaches the browser
```

Two demo surfaces exist: `web/static` was the first end-to-end proof, and
`frontend/` is the polished Next.js dashboard built from a designer-provided
mockup. Both talk to the same `web/server.py` backend.

## Setup

**Backend:**
```bash
pip install -r requirements.txt
python3 rag/build_index.py   # one-time: embed the FIA regs corpus
cd web && python3 -m uvicorn server:app --port 8420
```

**Frontend (Next.js, in a second terminal):**
```bash
cd frontend
npm install
npm run dev   # http://localhost:3000, proxies to the backend on :8420
```

Credentials live in `.env` (gitignored, not committed):
- `SPUR_API_KEY` — Spur Compute API key
- `SPUR_BASE_URL` — `https://ai.spuric.com/v1` (OpenAI-compatible)
- Models used: `spur-gemma` (Google Gemma 3 27B, reasoning) + `spur-embed` (Nomic Embed, RAG retrieval only — not Gemma)

## How a decision gets made

`orchestrator.decide()` implements Sense → Predict → Decide → Explain as a
two-pass loop:

1. **Tool selection** — Gemma reads recent telemetry + the tool catalog
   (`tools.py`: `estimate_degradation`, `pace_trend`, `compare_pit_windows`,
   `assess_traffic_risk`, `safety_car_pit_value`, `assess_thermal_risk`,
   `check_regulations`) and picks which to call, with what args — based on
   what's actually happening, not a fixed checklist.
2. **Deterministic execution** — those tools run as plain Python (or a
   `spur-embed` similarity search for `check_regulations`), not LLM calls,
   so the arithmetic and retrieval are reliable and auditable.
3. **Final decision** — Gemma reads the tool results and returns one
   <=30-word call, a confidence score, evidence citing the tool output, a
   real FIA article citation when relevant, and the alternative it rejected.

`gemma_triage.py` is the earlier single-shot prototype (one telemetry
snapshot → one Gemma call, no tool orchestration) — kept for reference/
comparison, superseded by `orchestrator.py`.

### Why a manual tool-calling loop instead of the OpenAI `tools=` API

Spur's Gemma 3 27B deployment returns 400 errors on both
`tool_choice="auto"` and a forced `tool_choice` — the upstream vLLM
server doesn't have `--enable-auto-tool-choice`/`--tool-call-parser` set.
Since we don't control that deployment, `orchestrator.py` implements tool
selection as structured JSON in the prompt instead of the native API.

### RAG: real FIA regulations, not fabricated text

`rag/corpus.json` holds 10 verbatim excerpts (Safety Car, VSC, pit lane
speed limit) pulled from the official
[2026 FIA F1 Sporting Regulations PDF](https://www.fia.com/system/files/documents/fia_2026_f1_regulations_-_section_b_sporting_-_iss_05_-_2026-02-27.pdf)
(`rag/source/`). `rag/build_index.py` embeds them with `spur-embed`
(Nomic Embed, 768-dim) into `rag/index.json`. At request time,
`check_regulations()` embeds only the query and does a cosine-similarity
lookup against the precomputed index — no re-embedding per request.

Real FastF1 telemetry was evaluated as a live/historical data source but
dropped: F1's live-timing CDN (`livetiming.formula1.com`, CloudFront)
returns 403 to this environment's network (a known issue — F1 blocks
non-residential/datacenter IPs). The 4 scenarios below are realistic
hand-built telemetry instead, chosen for reliability on demo day.

## Scenarios

| Scenario | Track | Story | Expected call |
|---|---|---|---|
| `degradation` | Monza | Tire wear crosses the cliff threshold | BOX |
| `traffic` | Silverstone | Car behind closes into DRS range | STAY OUT (traffic noted) |
| `safety_car` | Spa-Francorchamps | Caution period cuts effective pit loss | BOX (cites FIA B5.13.3) |
| `thermal` | Singapore | Power unit trends past the protection redline | LIFT & COAST |

## Submission requirements (Track: Pit Lane Telemetry)

Per the official rules, this repo is the required public fork of
[waterloodev/Build-With-Gemma](https://github.com/waterloodev/Build-With-Gemma)
(`LICENSE` kept as-is). To be eligible for judging we also need:

1. **Kaggle Writeup** — technical report: architecture, how Gemma was used, engineering hurdles, design choices
2. **Live Demo** — hosted Streamlit/Gradio app, terminal recording, or Kaggle Notebook judges can try
3. **This public repo** — well-documented, reproducible source

Scored out of 100: Gemma Integration (30), Innovation & Impact (30),
Functionality (20), Presentation & Writeup (20).

## Status

- [x] Forked required template repo, kept `LICENSE`/`TRACKS.md` intact
- [x] Deterministic analytics tools + RAG retrieval (`tools.py`)
- [x] Manual Gemma tool-orchestration loop (`orchestrator.py`), verified end-to-end
- [x] All 4 scenarios built and validated against real Gemma calls
- [x] RAG over real FIA 2026 regulations, cited in live decisions
- [x] `web/static` dashboard (vanilla JS) — first working demo
- [x] `frontend/` Next.js dashboard wired to real backend via Route Handlers
- [ ] Latency optimization (measured 3.7–4.8s vs. <2s target — see PLANNING.md)
- [ ] Deploy a publicly reachable live demo URL
- [ ] Kaggle Writeup

See `PLANNING.md` → "Measured vs. target" for full validation numbers.

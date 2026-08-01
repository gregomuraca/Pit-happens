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
openf1_source.py      Real F1 telemetry via api.openf1.org (2026 Belgian GP)
rag/                 FIA 2026 Sporting Regulations corpus + spur-embed index
scenarios/           4 hand-built lap-by-lap telemetry scenarios (CSV)
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

### Real F1 telemetry (OpenF1), not just hand-built scenarios

FastF1 was evaluated as a live/historical data source but its underlying
host is blocked: `livetiming.formula1.com` (CloudFront) returns 403 to
this environment's network — F1 blocks non-residential/datacenter IPs,
a known issue. **OpenF1** (`api.openf1.org`) is a different, unauthenticated,
reachable API serving the same kind of session data, and backs the
`belgian_gp_2026` scenario (`openf1_source.py`) with the actual 2026
Belgian GP — real lap times, gaps/intervals, race positions, tire
compound + stint age, weather, and race-control flags (a real safety car,
laps 2–4).

Public F1 data does not include tire wear %, tire/brake temperatures, ERS
energy, or fuel load — that's proprietary team telemetry, not broadcast
anywhere, not even on TV. Rather than inventing precise numbers for those,
`openf1_source.py` computes them from a documented estimate (e.g., tire
wear from real tyre age × a compound degradation rate) and tags exactly
which fields on each lap are estimated via `estimated_fields` — the
dashboard shows an "(EST.)" marker on those specific stat chips and a
"REAL DATA" badge with the same disclosure, so real and estimated data are
never visually indistinguishable.

## Scenarios

| Scenario | Track | Data | Story | Expected call |
|---|---|---|---|---|
| `degradation` | Monza | Hand-built | Tire wear crosses the cliff threshold | BOX |
| `traffic` | Silverstone | Hand-built | Car behind closes into DRS range | STAY OUT (traffic noted) |
| `safety_car` | Spa-Francorchamps | Hand-built | Caution period cuts effective pit loss | BOX (cites FIA B5.13.3) |
| `thermal` | Singapore | Hand-built | Power unit trends past the protection redline | LIFT & COAST |
| `belgian_gp_2026` | Spa-Francorchamps | **Real (OpenF1)** | Actual 2026 Belgian GP, laps 1–8, real safety car | BOX (cites FIA B5.13.3) |

## Credits

Third-party assets, all deliberately unbranded — no team liveries or
manufacturer trademarks are used anywhere in the dashboard.

| Asset | Source | License |
| --- | --- | --- |
| Circuit outlines (`frontend/app/page.tsx`) | [julesr0y/f1-circuits-svg](https://github.com/julesr0y/f1-circuits-svg) | CC-BY-4.0 |
| 3D car model — "2020 Tatuus FT-60" | [Dave Love](https://sketchfab.com/davelove) on [Sketchfab](https://sketchfab.com/3d-models/2020-tatuus-ft-60-41c932d44ed94b1cb19100580e440aba) | CC Attribution |
| `frontend/public/formula-car.png` | Static fallback render | — |

The 3D model is embed-only (not downloadable), so it runs inside Sketchfab's
viewer via the Viewer API rather than a self-hosted three.js scene. That makes
it a live network dependency: every failure path falls back to the static PNG,
and `NEXT_PUBLIC_CAR_3D=0` forces the PNG outright for offline demos.

Thermal shading (tyres, brakes, engine glowing red with temperature) works by
matching material *names*, and Sketchfab's API exposes `materialCount` but never
the names themselves — so whether a given model can be shaded is only knowable
by loading it. To trial another model without a code change:

    http://localhost:3000/?model=<32-hex-sketchfab-uid>   # one-off
    NEXT_PUBLIC_CAR_3D_UID=<uid>                          # pin it

The console logs `[car3d] materials: [...]` and the matched groups on load.

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
- [x] Real F1 telemetry via OpenF1 (`belgian_gp_2026` scenario) — real laps, gaps, positions, weather, and a real safety car; estimated fields (tire/brake/ERS/fuel) clearly tagged
- [ ] Latency optimization (measured 3.7–4.8s vs. <2s target — see PLANNING.md)
- [ ] Deploy a publicly reachable live demo URL
- [ ] Kaggle Writeup

See `PLANNING.md` → "Measured vs. target" for full validation numbers.

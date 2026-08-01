# PIT//CALL — Power Strategy

Competition: [Build With Gemma: Triage In Light Speed](https://www.kaggle.com/competitions/build-with-gemma-triage-in-light-speed/overview)
Track: Pit Lane Telemetry (F1 Strategy)

Applies Hamilton Helmer's 7 Powers framework on top of the original
PIT//CALL product framework — a strength only counts as durable Power if
it creates a barrier competitors can't quickly copy, not just a benefit.

## 1. Objective
> Race engineers must interpret large volumes of telemetry while the
> decision window is rapidly closing. We create a reliable, explainable
> pit-stop recommendation before the next lap.

## 2. Arena and Users
> Primary: race strategist/engineer — needs immediate risk/opportunity
> identification, reliable pit-window comparisons, short actionable
> recommendations, evidence + confidence behind each call.
> Secondary: driver — needs one instruction: BOX, STAY OUT, or MANAGE TYRES.
> Market: motorsport teams, initially hackathon/demo scale.

## 3. Benefit
> Compared with manual telemetry reading under time pressure, PIT//CALL
> delivers a defensible recommendation in seconds instead of minutes,
> because deterministic tools do the arithmetic reliably and Gemma
> synthesizes it into one explainable, evidence-backed call.

## 4. Power Hypothesis
Primary: **Switching Costs** (team-specific telemetry calibration, integrations, accumulated strategy history).
Reinforcing: **Process Power** (embedded decision + post-race learning loop).
Possible: **Cornered Resource** (exclusive annotated race data / engineering partnerships).
Explicitly weak: **Network Economies** — racing teams are unlikely to share sensitive telemetry with competitors, so this Power doesn't apply here and we're not forcing it.

## 5. Barrier
> Not Gemma, not the dashboard — both are reproducible by any competitor.
> The barrier is the *accumulated combination* of: team-specific
> models/thresholds, historical decisions linked to outcomes, deep
> workflow/telemetry integrations, trust built through validated calls,
> and a proprietary evaluation process that improves after every race.
> **Failure condition**: if teams don't retain/reuse strategy history across
> races, switching costs never accumulate and the barrier doesn't form.

## 6. Power Path
- **Origination**: Gemma makes explainable, tool-orchestrated LLM reasoning cheap enough to run trackside/locally.
- **Takeoff**: Sense → Predict → Decide → Explain → Respond pillars (below) get one team to a working, trusted decision loop.
- **Accumulation**: team-specific calibration data and race-outcome history build up per team.
- **Stability**: once a team's strategy history and integrations are embedded, switching to a generic competitor tool means losing that accumulated context.

### Pillars (capabilities the Power Path depends on)
| Pillar | What we deliver |
|---|---|
| Sense | Continuously interpret telemetry, gaps, tyres, track conditions |
| Predict | Identify degradation, tire cliffs, pit-window outcomes |
| Decide | Gemma selects and coordinates the right analytical tools |
| Explain | One recommendation, with evidence, confidence, alternatives |
| Respond | Deliver the decision before the strategic window closes |

## 7. Proof and Roadmap

| Phase | Deliverable | Status |
|---|---|---|
| Foundation | Scenario, telemetry schema, tool definitions | done — `tools.py`, `scenarios/degradation.csv` |
| Intelligence | Degradation + pit-window calculations | done — tested against real scenario |
| Gemma integration | Complete function-calling loop | done — manual 2-pass protocol (see below); traffic/safety-car scenarios pending |
| Experience | Live dashboard / crew-chief interface | not started |
| Validation | Three repeatable race scenarios | 1 of 3 (degradation) |
| Submission | Video, cover image, notebook, write-up | not started |

**Engineering hurdle worth writing up**: Spur's Gemma 3 27B deployment
doesn't have vLLM's native OpenAI tool-calling enabled server-side
(`--enable-auto-tool-choice`/`--tool-call-parser` unset — confirmed via
400 errors on both `tool_choice="auto"` and forced tool_choice). Built a
manual two-pass structured-JSON protocol instead: Gemma selects tools →
we execute deterministically → Gemma explains the result. This is
`orchestrator.py`.

### Measured vs. target (hackathon validation)
| Target | Result |
|---|---|
| Recommendation in <2s | 3.73s measured (two sequential Gemma round-trips) — not yet met, see optimization ideas below |
| Tire cliff detected ≥1 lap in advance | met — FR wear hit 85% cliff threshold, correctly flagged `cliff_imminent: true` |
| Pit-now vs. stay-out compared numerically | met — `compare_pit_windows` tool |
| Every recommendation backed by tool results | met — evidence array cites tool outputs |
| Decision in <30 words | met — 20 words on first real test |
| 3 scenarios: degradation, traffic, safety car | 1 of 3 built |

Latency optimization ideas (not yet implemented): collapse the 2-pass
protocol into 1 call when the tool set is small/predictable, or run tool
selection as a fast heuristic (always call all 3 tools) and skip pass 1's
LLM round-trip entirely, keeping Gemma only for the final Explain step.

## Open items
1. Build `traffic.csv` and `safety_car.csv` scenarios + verify orchestrator on both.
2. Decide + build the live demo surface (Streamlit/Gradio dashboard vs. terminal recording vs. Kaggle Notebook) — required submission artifact.
3. Latency optimization pass to close the gap to <2s.
4. Kaggle Writeup — not started.

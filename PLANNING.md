# Pit Lane Telemetry — Strategy

Competition: [Build With Gemma: Triage In Light Speed](https://www.kaggle.com/competitions/build-with-gemma-triage-in-light-speed/overview)
Theme: Pit Lane Telemetry (F1 Strategy) — turn raw telemetry streams into winning race strategies.

## 1. Objective
What challenge are we responding to?
> Race engineers get hundreds of telemetry data points per second (tire temps/wear, engine thermals, gaps to cars ahead/behind, sector times) and have seconds — not minutes — to turn that into a strategy call: pit now or stay out, push or manage, defend or attack. The challenge: build a Gemma-powered app that triages this stream in real time and surfaces a clear, fast strategy recommendation.

## 2. Users
Who are we serving, what do they need?
> Race engineers / strategists (primary) — need a fast, trustworthy read on "what does this data mean right now," not another dashboard of raw numbers.
> Secondary: fans/broadcast — a simplified version could narrate strategy in plain language for viewers.

## 3. Superpowers
Where can we persistently deliver superior returns?
> - Gemma's speed + small footprint → can run triage inference fast enough to matter in a live-race context (this is the "Light Speed" angle).
> - Turning noisy multi-signal telemetry into a single plain-language call is an LLM-shaped problem (synthesis + judgment), not just a stats/ML forecasting one.

## 4. Vision
What future are we building?
> A co-pilot that sits next to the race engineer and continuously narrates "here's what's happening and here's the call," so strategy decisions are faster and less error-prone under pressure.

## 5. Pillars
What do we need to deliver to get there?
> - **Data pipeline**: ingest/simulate telemetry stream (tire deg, thermals, gaps, lap times)
> - **Gemma triage engine**: prompt design that turns a telemetry window into a structured strategy call + confidence + reasoning
> - **Interface**: live dashboard or CLI that shows the call as it updates
> - **Demo narrative**: a compelling before/after (raw telemetry chaos → clear call) for judges

## 6. Impact
How will we measure progress toward the objective?
> - Latency: time from data window → strategy call (the "light speed" judging angle)
> - Decision quality: do the calls match what a real strategist would flag (spot-check against known race moments)
> - Clarity: can a non-expert understand the call and why, in one glance

## 7. Roadmap
How do we share progress?
> - [ ] MVP: static/sample telemetry → Gemma call, CLI or notebook
> - [ ] v2: simulated live stream → updating dashboard
> - [ ] Polish: demo video + writeup for submission
> - [ ] Submit

---

## Open items blocking build
1. ~~Spur account had $0 credit~~ — resolved, $200 added.
2. ~~Gemma availability on Spur unconfirmed~~ — resolved. `spur-gemma` = Google Gemma 3 27B (multimodal, 131K context). End-to-end triage call verified working.
3. **Full Kaggle rules not yet reviewed** — the competition page is JS-rendered and I couldn't pull deliverable/judging/deadline details automatically. Need these to size the MVP correctly (CLI vs. live dashboard vs. notebook, video requirement, deadline).

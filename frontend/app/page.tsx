"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------- Types (mirror orchestrator.decide() / server.py response shape) ----------

interface LapTelemetry {
  lap: number;
  total_laps: number;
  driver: string;
  gap_ahead_sec: number;
  gap_behind_sec: number;
  tire_compound: string;
  tire_age_laps: number;
  tire_wear_pct: { FL: number; FR: number; RL: number; RR: number };
  tire_temps_c: { FL: number; FR: number; RL: number; RR: number };
  brake_temp_c: number;
  energy_pct: number;
  engine_temp_c: number;
  fuel_kg: number;
  lap_time_sec: number;
  track_status: string;
}

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

interface Decision {
  call?: string;
  confidence_pct?: number;
  evidence?: string[];
  regulation_citation?: string | null;
  alternative_considered?: string;
  error?: string;
  raw?: string;
}

interface ScenarioMeta {
  id: string;
  label: string;
  track: string;
  session: string;
  weather: { track_c: number; air_c: number; condition: string; wind_kmh: number };
  pit_stop_loss_sec: number;
  first_lap: number;
  last_lap: number;
  total_laps: number;
}

interface DecideResponse {
  latest_lap: LapTelemetry;
  tool_calls: ToolCall[];
  decision: Decision;
  elapsed_sec: number;
  meta: ScenarioMeta;
  progress: { current_lap: number; first_lap: number; last_lap: number; total_laps: number };
}

interface EventItem {
  key: string;
  lap: number;
  type: "info" | "warn" | "danger";
  icon: string;
  title: string;
  sub: string;
}

// ---------- Helpers ----------

function buildSparkPath(values: number[], width = 340, height = 120, pad = 14): string {
  if (values.length < 2) {
    const y = height / 2;
    return `M0 ${y} L${width} ${y}`;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - pad - ((v - min) / span) * (height - pad * 2);
    return [x, y];
  });
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
}

function parseCallLabel(call: string | undefined): { label: string; sub: string } {
  if (!call) return { label: "NO CALL", sub: "" };
  const match = call.match(/^(BOX(?: NOW)?|STAY OUT|MANAGE TYRES|LIFT & COAST)/i);
  const label = match ? match[0].toUpperCase() : call.split(".")[0].split(",")[0].toUpperCase();
  const rest = call.slice(label.length).replace(/^[.,]\s*/, "").trim();
  return { label, sub: rest };
}

const TRACK_PATHS: Record<string, string> = {
  Monza:
    "M74 183 C45 170 39 134 47 82 C51 51 47 27 74 20 C96 14 127 18 136 36 C153 70 168 77 197 83 C227 90 240 112 266 124 C301 141 356 138 385 156 C411 172 402 196 372 199 C327 202 287 182 247 181 C199 181 162 201 120 199 C102 198 86 191 74 183Z",
  Silverstone:
    "M60 40 C90 18 150 14 185 34 C205 46 200 66 222 70 C248 75 254 50 285 52 C325 55 345 85 325 108 C308 128 272 116 246 134 C214 158 150 152 108 134 C68 118 45 80 60 40Z",
  "Spa-Francorchamps":
    "M40 150 C32 115 52 88 82 86 C102 84 96 58 122 50 C185 30 285 28 340 52 C378 68 398 96 380 122 C364 144 316 136 284 152 C228 178 118 180 72 160 C50 150 44 165 40 150Z",
  Singapore:
    "M50 60 L120 55 L128 75 L200 70 L205 95 L280 90 C320 88 350 100 348 130 C346 158 310 168 270 160 L150 150 C100 146 60 135 55 105 Z",
};

const AHEAD_COLOR = "#ffb547";
const US_COLOR = "#19d3e6";
const BEHIND_COLOR = "#ff4f5e";

// ---------- Components ----------

function LineChart({
  title,
  value,
  unit,
  path,
  lapLabel,
  amber = false,
}: {
  title: string;
  value: string;
  unit: string;
  path: string;
  lapLabel: string;
  amber?: boolean;
}) {
  return (
    <article className="chart-card">
      <header className="chart-head">
        <div>
          <span>{title}</span>
          <small>{unit}</small>
        </div>
        <strong className={amber ? "amber" : "cyan"}>{value}</strong>
      </header>
      <svg className="spark-chart" viewBox="0 0 340 120" preserveAspectRatio="none" aria-label={`${title} telemetry chart`}>
        <defs>
          <linearGradient id={`fill-${title.replaceAll(" ", "-")}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={amber ? "#ffb547" : "#19d3e6"} stopOpacity=".28" />
            <stop offset="1" stopColor={amber ? "#ffb547" : "#19d3e6"} stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="grid-lines">
          <line x1="0" y1="20" x2="340" y2="20" />
          <line x1="0" y1="60" x2="340" y2="60" />
          <line x1="0" y1="100" x2="340" y2="100" />
        </g>
        <path d={`${path} L340 120 L0 120 Z`} fill={`url(#fill-${title.replaceAll(" ", "-")})`} />
        <path d={path} className={amber ? "chart-line amber-stroke" : "chart-line"} />
        <line x1="302" y1="4" x2="302" y2="113" className="lap-marker" />
        <text x="307" y="115" className="chart-lap">{lapLabel}</text>
      </svg>
    </article>
  );
}

function TrackMap({ trackName, progressFrac }: { trackName: string; progressFrac: number }) {
  const pathRef = useRef<SVGPathElement>(null);
  const [marker, setMarker] = useState({ x: 0, y: 0 });
  const [dots, setDots] = useState<{ x: number; y: number }[]>([]);
  const d = TRACK_PATHS[trackName] ?? TRACK_PATHS.Monza;

  useEffect(() => {
    const el = pathRef.current;
    if (!el) return;
    const len = el.getTotalLength();
    const pt = el.getPointAtLength(len * Math.min(Math.max(progressFrac, 0), 1));
    setMarker({ x: pt.x, y: pt.y });
    setDots([0.15, 0.4, 0.65, 0.85].map((f) => el.getPointAtLength(len * f)));
  }, [d, progressFrac]);

  return (
    <svg className="track-map" viewBox="0 0 430 220" role="img" aria-label={`${trackName} circuit map with live car position`}>
      <path className="track-shadow" d={d} />
      <path ref={pathRef} className="track-line" d={d} />
      <g className="track-dots">
        {dots.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={5} />
        ))}
        <circle className="our-dot" cx={marker.x} cy={marker.y} r={9} />
      </g>
    </svg>
  );
}

function VehiclePanel({ lap, thermalWarning }: { lap: LapTelemetry | null; thermalWarning: boolean }) {
  if (!lap) return null;
  return (
    <section className="vehicle-panel panel" aria-labelledby="vehicle-title">
      <div className="section-kicker">
        <span className="status-dot" /> {lap.driver} · VEHICLE STATE <b>LAP {String(lap.lap).padStart(3, "0")}</b>
      </div>
      <h1 id="vehicle-title" className="sr-only">Live vehicle state</h1>
      <div className="car-stage">
        <div className="car-aura" />
        <img className="formula-car" src="/formula-car.png" alt="Unbranded graphite Formula-style racing car viewed from above" />
        <div className="callout callout-rl"><span>REAR LEFT TYRE</span><strong>{lap.tire_temps_c.RL}°C · {lap.tire_wear_pct.RL}%</strong></div>
        <div className="callout callout-rr"><span>REAR RIGHT TYRE</span><strong>{lap.tire_temps_c.RR}°C · {lap.tire_wear_pct.RR}%</strong></div>
        <div className="callout callout-fl"><span>FRONT LEFT TYRE</span><strong>{lap.tire_temps_c.FL}°C · {lap.tire_wear_pct.FL}%</strong></div>
        <div className="callout callout-fr"><span>FRONT RIGHT TYRE</span><strong>{lap.tire_temps_c.FR}°C · {lap.tire_wear_pct.FR}%</strong></div>
        <div className={`callout callout-pu ${thermalWarning ? "warning-callout" : ""}`}><span>POWER UNIT</span><strong>{lap.engine_temp_c}°C · {thermalWarning ? "HIGH" : "NOMINAL"}</strong></div>
        <div className="callout callout-br"><span>BRAKES</span><strong>{lap.brake_temp_c}°C</strong></div>
        <div className="callout callout-en"><span>ENERGY</span><strong>{lap.energy_pct}%</strong></div>
        <div className="callout callout-fu"><span>FUEL</span><strong>{lap.fuel_kg} kg</strong></div>
      </div>
    </section>
  );
}

function EventFeed({ events }: { events: EventItem[] }) {
  const shown = events.slice(0, 3);
  return (
    <div className="event-strip">
      <header><span>EVENT INTELLIGENCE</span><small>LIVE FEED</small></header>
      <div className="events">
        {shown.length === 0 && (
          <article><time>—</time><span className="event-icon">·</span><div><strong>No events yet</strong><small>Advance the lap</small></div></article>
        )}
        {shown.map((e) => (
          <article key={e.key}>
            <time className={e.type === "warn" ? "amber" : e.type === "danger" ? "orange" : undefined}>L{e.lap}</time>
            <span className={`event-icon ${e.type === "warn" ? "flag-icon" : e.type === "danger" ? "tyre-icon" : ""}`}>{e.icon}</span>
            <div><strong>{e.title}</strong><small>{e.sub}</small></div>
          </article>
        ))}
      </div>
    </div>
  );
}

function StrategyPanel({
  data,
  loading,
  sent,
  onSend,
}: {
  data: DecideResponse | null;
  loading: boolean;
  sent: boolean;
  onSend: () => void;
}) {
  const decision = data?.decision;
  const { label, sub } = parseCallLabel(decision?.call);
  const subDisplay = sub || (data ? `${data.latest_lap.tire_compound.toUpperCase()} TYRES` : "");

  // Pick one contextual third metric from whichever tool actually ran.
  let thirdLabel = "MARGIN";
  let thirdValue = "—";
  const results = Object.fromEntries((data?.tool_calls ?? []).map((t) => [t.tool, t.result]));
  if (results.compare_pit_windows) {
    thirdLabel = "PIT MARGIN";
    thirdValue = `${(results.compare_pit_windows as { margin_sec?: number }).margin_sec ?? "—"}s`;
  } else if (results.safety_car_pit_value) {
    thirdLabel = "SC SAVINGS";
    thirdValue = `${(results.safety_car_pit_value as { sec_saved_vs_normal_pit?: number }).sec_saved_vs_normal_pit ?? "—"}s`;
  } else if (results.assess_thermal_risk) {
    thirdLabel = "LIFT LAPS";
    thirdValue = `${(results.assess_thermal_risk as { lift_and_coast_laps_recommended?: number }).lift_and_coast_laps_recommended ?? "—"}`;
  }

  return (
    <aside className="strategy-card panel" aria-labelledby="strategy-title">
      <div className="strategy-eyebrow">
        <span className="analysis-glyph">✦</span> GEMMA ANALYSIS
        <span className="analysis-time">{data ? `${data.elapsed_sec}s` : loading ? "…" : "—"}</span>
      </div>
      <div className={`decision-lockup ${loading ? "thinking" : ""}`}>
        <span className="target-glyph"><i /></span>
        <div>
          <h2 id="strategy-title">{loading ? "ANALYZING…" : label}</h2>
          <p>{loading ? "TELEMETRY → GEMMA" : subDisplay}</p>
        </div>
      </div>
      <div className="strategy-metrics">
        <div><span>CONFIDENCE</span><strong>{decision?.confidence_pct != null ? `${decision.confidence_pct}%` : "—"}</strong></div>
        <div><span>LATENCY</span><strong>{data ? `${data.elapsed_sec}s` : "—"}</strong></div>
        <div><span>{thirdLabel}</span><strong>{thirdValue}</strong></div>
      </div>
      <div className="reasoning">
        <span>WHY NOW</span>
        <p>{decision?.call ?? (loading ? "Waiting on Gemma…" : "—")}</p>
      </div>
      {decision?.regulation_citation && (
        <div className="reg-citation"><b>§</b> FIA {decision.regulation_citation}</div>
      )}
      <div className="function-flow dynamic" aria-label="Gemma function calls">
        {(data?.tool_calls ?? []).map((t, i, arr) => (
          <span key={t.tool} className={i === arr.length - 1 ? "active" : undefined}>{t.tool}()</span>
        ))}
      </div>
      <button
        type="button"
        className={`radio-button ${sent ? "sent" : ""}`}
        onClick={onSend}
        disabled={sent || !data}
      >
        <span /> {sent ? "RADIO MESSAGE SENT" : "SEND TO DRIVER"} <kbd>{sent ? "✓" : "↵"}</kbd>
      </button>
    </aside>
  );
}

// ---------- Main ----------

const PLAY_TICK_MS = 200; // brief pacing between auto-play laps once a response lands

export default function Home() {
  const [scenarios, setScenarios] = useState<ScenarioMeta[]>([]);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [data, setData] = useState<DecideResponse | null>(null);
  const [history, setHistory] = useState<LapTelemetry[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [sent, setSent] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [clock, setClock] = useState("--:--:--");
  const seenEvents = useRef<Set<string>>(new Set());
  const runningRef = useRef(false);

  useEffect(() => {
    const update = () => setClock(new Date().toLocaleTimeString("en-CA", { hour12: false }));
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    fetch("/api/scenarios")
      .then((r) => r.json())
      .then((list: ScenarioMeta[]) => {
        setScenarios(list);
        if (list.length) setScenarioId(list[0].id);
      });
  }, []);

  const deriveEvents = useCallback((resp: DecideResponse) => {
    const lap = resp.latest_lap;
    const results = Object.fromEntries(resp.tool_calls.map((t) => [t.tool, t.result]));
    const found: EventItem[] = [];

    const flag = `flag_${lap.track_status}`;
    if (lap.track_status !== "green" && !seenEvents.current.has(flag)) {
      seenEvents.current.add(flag);
      found.push({ key: flag, lap: lap.lap, type: "warn", icon: "⚑", title: lap.track_status.replace("_", " ").toUpperCase(), sub: "Track status change" });
    }
    const deg = results.estimate_degradation as { cliff_imminent?: boolean; tire?: string; current_wear_pct?: number } | undefined;
    if (deg?.cliff_imminent && !seenEvents.current.has("cliff")) {
      seenEvents.current.add("cliff");
      found.push({ key: "cliff", lap: lap.lap, type: "danger", icon: "◉", title: "Tyre cliff imminent", sub: `${deg.tire} wear at ${deg.current_wear_pct}%` });
    }
    const traf = results.assess_traffic_risk as { under_attack?: boolean; gap_behind_sec?: number; drs_range_ahead?: boolean; gap_ahead_sec?: number } | undefined;
    if (traf?.under_attack && !seenEvents.current.has("attack")) {
      seenEvents.current.add("attack");
      found.push({ key: "attack", lap: lap.lap, type: "warn", icon: "▱", title: "Under attack", sub: `Gap behind ${traf.gap_behind_sec}s` });
    }
    if (traf?.drs_range_ahead && !seenEvents.current.has("drs")) {
      seenEvents.current.add("drs");
      found.push({ key: "drs", lap: lap.lap, type: "info", icon: "➤", title: "DRS range ahead", sub: `Gap ${traf.gap_ahead_sec}s — overtake chance` });
    }
    const sc = results.safety_car_pit_value as { rare_opportunity?: boolean; sec_saved_vs_normal_pit?: number } | undefined;
    if (sc?.rare_opportunity && !seenEvents.current.has("sc_opp")) {
      seenEvents.current.add("sc_opp");
      found.push({ key: "sc_opp", lap: lap.lap, type: "info", icon: "★", title: "Cheap pit window", sub: `Saves ${sc.sec_saved_vs_normal_pit}s` });
    }
    const th = results.assess_thermal_risk as { in_protection_risk?: boolean; current_temp_c?: number } | undefined;
    if (th?.in_protection_risk && !seenEvents.current.has("thermal")) {
      seenEvents.current.add("thermal");
      found.push({ key: "thermal", lap: lap.lap, type: "danger", icon: "◉", title: "Thermal protection risk", sub: `PU at ${th.current_temp_c}°C` });
    }

    if (found.length) setEvents((prev) => [...found.reverse(), ...prev]);
  }, []);

  const fetchLap = useCallback(
    async (scenario: string, lap: number) => {
      setLoading(true);
      const res = await fetch(`/api/decide?scenario=${scenario}&lap=${lap}`);
      const json: DecideResponse = await res.json();
      setLoading(false);
      setData(json);
      setHistory((prev) => [...prev, json.latest_lap].slice(-8));
      deriveEvents(json);
      if (voiceOn && "speechSynthesis" in window && json.decision?.call) {
        const { label, sub } = parseCallLabel(json.decision.call);
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(`${label}. ${sub}`));
      }
      return json;
    },
    [deriveEvents, voiceOn],
  );

  // Scenario switch
  useEffect(() => {
    if (!scenarioId) return;
    const meta = scenarios.find((s) => s.id === scenarioId);
    if (!meta) return;
    setRunning(false);
    runningRef.current = false;
    setSent(false);
    setHistory([]);
    setEvents([]);
    seenEvents.current = new Set();
    fetchLap(scenarioId, meta.first_lap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioId, scenarios]);

  const selectScenario = (id: string) => setScenarioId(id);

  const stepNext = useCallback(async () => {
    if (!data || !scenarioId) return;
    const { current_lap, last_lap } = data.progress;
    if (current_lap >= last_lap) {
      setRunning(false);
      runningRef.current = false;
      return;
    }
    setSent(false);
    await fetchLap(scenarioId, current_lap + 1);
  }, [data, scenarioId, fetchLap]);

  const toggleRunning = () => {
    const next = !running;
    setRunning(next);
    runningRef.current = next;
    if (next) void playLoop();
  };

  const playLoop = async () => {
    while (runningRef.current) {
      if (!data) break;
      const { current_lap, last_lap } = data.progress;
      if (current_lap >= last_lap) {
        setRunning(false);
        runningRef.current = false;
        break;
      }
      await stepNext();
      await new Promise((r) => setTimeout(r, PLAY_TICK_MS));
    }
  };

  const meta = data?.meta;
  const progress = data?.progress;
  const progressFrac = progress ? (progress.current_lap - 1) / Math.max(progress.total_laps - 1, 1) : 0;
  const thermalWarning = Boolean(
    (Object.fromEntries((data?.tool_calls ?? []).map((t) => [t.tool, t.result])).assess_thermal_risk as
      | { in_protection_risk?: boolean }
      | undefined)?.in_protection_risk,
  );

  const paceValues = history.map((l) => l.lap_time_sec);
  const wearValues = history.map((l) => Math.max(l.tire_wear_pct.FL, l.tire_wear_pct.FR, l.tire_wear_pct.RL, l.tire_wear_pct.RR));
  const puValues = history.map((l) => l.engine_temp_c);
  const lastLap = history[history.length - 1];

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand"><strong>PIT<span>//</span>CALL</strong><small>Pit Happens</small></div>
        <div className="session-meta">
          <span className="live-pill"><i /> LIVE</span>
          <span>{(meta?.track ?? "—").toUpperCase()} · {(meta?.session ?? "—").toUpperCase()}</span>
          <span>LAP <b>{progress?.current_lap ?? "—"}</b> / {progress?.total_laps ?? "—"}</span>
        </div>
        <button className="stream-toggle voice" onClick={() => setVoiceOn((v) => !v)} aria-label="Toggle voice">
          {voiceOn ? "🔊 VOICE" : "🔇 VOICE"}
        </button>
        <button className={`stream-toggle ${running ? "" : "paused"}`} onClick={toggleRunning} aria-label={running ? "Pause telemetry" : "Resume telemetry"}>
          {running ? "PAUSE" : "RESUME"}
        </button>
        <div className="clock">{clock}</div>
      </header>

      <nav className="scenario-bar" aria-label="Strategy scenarios">
        <span>SCENARIO</span>
        {scenarios.map((s) => (
          <button key={s.id} className={scenarioId === s.id ? "active" : ""} onClick={() => selectScenario(s.id)}>
            {s.label.toUpperCase()}
          </button>
        ))}
        <small>{running ? "TELEMETRY STREAMING" : "STREAM PAUSED"}</small>
      </nav>

      <div className="dashboard-grid">
        <VehiclePanel lap={data?.latest_lap ?? null} thermalWarning={thermalWarning} />
        <section className="right-rail">
          <div className="race-context panel">
            <div className="track-wrap"><TrackMap trackName={meta?.track ?? "Monza"} progressFrac={progressFrac} /></div>
            <div className="track-stats">
              <div><span className="weather-icon thermometer" /><p><small>TRACK</small><strong>{meta?.weather.track_c ?? "—"}°C</strong></p></div>
              <div><span className="weather-icon cloud" /><p><small>AIR</small><strong>{meta?.weather.air_c ?? "—"}°C</strong></p></div>
              <div><span className="weather-icon" /><p><small>CONDITION</small><strong>{(meta?.weather.condition ?? "—").toUpperCase()}</strong></p></div>
              <div><span className="weather-icon wind" /><p><small>WIND</small><strong>{meta?.weather.wind_kmh ?? "—"} km/h</strong></p></div>
              <div><span className="weather-icon timer" /><p><small>PIT LOSS</small><strong>{meta?.pit_stop_loss_sec ?? "—"}s</strong></p></div>
            </div>
          </div>
          <div className="leaderboard panel" aria-label="Live race positions">
            {lastLap && (
              <>
                <div><b>–1</b><i style={{ background: AHEAD_COLOR }} /><strong>AHEAD</strong><span>-{lastLap.gap_ahead_sec.toFixed(1)}s</span></div>
                <div className="our-position"><b>P—</b><i style={{ background: US_COLOR }} /><strong>{lastLap.driver}</strong><span>—</span></div>
                <div><b>+1</b><i style={{ background: BEHIND_COLOR }} /><strong>BEHIND</strong><span>+{lastLap.gap_behind_sec.toFixed(1)}s</span></div>
              </>
            )}
          </div>
          <StrategyPanel data={data} loading={loading} sent={sent} onSend={() => setSent(true)} />
        </section>
      </div>

      <div className="vehicle-panel panel" style={{ borderWidth: 0, padding: "0 20px 16px" }}>
        <div className="chart-grid">
          <LineChart title="PACE" unit="s" value={lastLap ? lastLap.lap_time_sec.toFixed(1) : "—"} path={buildSparkPath(paceValues)} lapLabel={lastLap ? `L${lastLap.lap}` : ""} />
          <LineChart title="TYRE DEG" unit="%" value={lastLap ? String(Math.max(lastLap.tire_wear_pct.FL, lastLap.tire_wear_pct.FR, lastLap.tire_wear_pct.RL, lastLap.tire_wear_pct.RR)) : "—"} amber path={buildSparkPath(wearValues)} lapLabel={lastLap ? `L${lastLap.lap}` : ""} />
          <LineChart title="POWER UNIT" unit="°C" value={lastLap ? String(lastLap.engine_temp_c) : "—"} amber={thermalWarning} path={buildSparkPath(puValues)} lapLabel={lastLap ? `L${lastLap.lap}` : ""} />
        </div>
        <EventFeed events={events} />
      </div>
    </main>
  );
}

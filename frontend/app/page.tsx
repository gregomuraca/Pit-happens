"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import CarModel3D from "./CarModel3D";

// Set NEXT_PUBLIC_CAR_3D=0 to force the static PNG (offline demos, weak GPUs).
const CAR_3D_ENABLED = process.env.NEXT_PUBLIC_CAR_3D !== "0";

// ---------- Types (mirror orchestrator.decide() / server.py response shape) ----------

interface LapTelemetry {
  lap: number;
  total_laps: number;
  driver: string;
  position?: number;
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
  estimated_fields?: string[];
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
  is_real?: boolean;
  data_note?: string;
}

interface DecideResponse {
  latest_lap: LapTelemetry;
  tool_calls: ToolCall[];
  decision: Decision;
  elapsed_sec: number;
  meta: ScenarioMeta;
  progress: { current_lap: number; first_lap: number; last_lap: number; total_laps: number };
  standings?: StandingRow[];
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

interface StandingRow {
  pos: number;
  car: string;
  gapToLeader: string;
  isUs: boolean;
}

// We only have real telemetry for OUR car's gap to the car directly ahead/
// behind (gap_ahead_sec / gap_behind_sec) — not a full 20-car grid. This
// builds a labeled, clearly-synthetic field (CAR_XX, not real drivers)
// anchored on those two real values, so the "Interval" rail is honest about
// what's real vs. filled in for display purposes.
function seededRand(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function buildStandings(lap: LapTelemetry, ourPos: number, field: number): StandingRow[] {
  const ourIdx = ourPos - 1;
  const ourNumber = Number(lap.driver.replace(/\D/g, "")) || -1;

  const intervalToAhead: number[] = new Array(field).fill(0);
  intervalToAhead[ourIdx] = lap.gap_ahead_sec;
  if (ourIdx + 1 < field) intervalToAhead[ourIdx + 1] = lap.gap_behind_sec;
  for (let i = 1; i < field; i++) {
    if (i === ourIdx || i === ourIdx + 1) continue;
    intervalToAhead[i] = Number((0.6 + seededRand(lap.lap * 13 + i * 7) * 2.8).toFixed(1));
  }

  const usedNumbers = new Set([ourNumber]);
  function nextCarNumber(i: number): number {
    let n = 4 + i * 3;
    while (usedNumbers.has(n)) n += 1;
    usedNumbers.add(n);
    return n;
  }

  let cumulative = 0;
  return intervalToAhead.map((iv, i) => {
    cumulative += i === 0 ? 0 : iv;
    return {
      pos: i + 1,
      car: i === ourIdx ? lap.driver : `CAR_${String(nextCarNumber(i)).padStart(2, "0")}`,
      gapToLeader: i === 0 ? "LEADER" : `+${cumulative.toFixed(1)}s`,
      isUs: i === ourIdx,
    };
  });
}

function parseCallLabel(call: string | undefined): { label: string; sub: string } {
  if (!call) return { label: "NO CALL", sub: "" };
  const match = call.match(/^(BOX(?: NOW)?|STAY OUT|MANAGE TYRES|LIFT & COAST)/i);
  const label = match ? match[0].toUpperCase() : call.split(".")[0].split(",")[0].toUpperCase();
  const rest = call.slice(label.length).replace(/^[.,]\s*/, "").trim();
  return { label, sub: rest };
}

function formatSpeechText(text: string): string {
  return text
    .replace(/(\d+(?:\.\d+)?)\s*s\b/gi, "$1 seconds")
    .replace(/(\d+)\s*°\s*C\b/gi, "$1 degrees C")
    .replace(/\bL(\d+)\b/g, "lap $1");
}

// Real circuit outlines (current-era layout for each track), sourced from
// julesr0y/f1-circuits-svg (CC-BY-4.0) — see README credits. viewBox 0 0 500 500.
const TRACK_VIEWBOX = "0 0 500 500";
const TRACK_PATHS: Record<string, string> = {
  Monza:
    "M218.372 50.51c17.128-1.458 28.349-2.045 40.274-3.238 9.544-.954 18.648-.863 32.116-1.38 3.542-.136 3.729-.748 5.353-5.354 1.036-2.935 1.478-4.501 4.144-4.835 5.525-.69 9.921-1.651 11.443-2.091 14.149-4.09 33.715-10.744 48.213-17.291 6.233-2.814 20.461 2.978 21.497 16.187s3.53 38.46 4.015 45.973c.518 8.029.022 9.197-4.533 11.655-9.842 5.31-36.237 19.593-46.102 25.511-14.892 8.936-29.224 17.864-38.59 26.03-10.102 8.806-73.808 64.464-80.377 70.318-3.39 3.023-6.907 6.216-12.087 10.705-3.24 2.809-2.08 5.871-1.38 10.878 1.035 7.425-.519 16.403-8.289 21.756-5.758 3.967-6.446 5.425-7.248 12.962-4.732 44.498-20.042 187.268-21.674 201.017-1.813 15.28-17.22 18.9-29.267 11.784-24.993-14.763-21.878-47.89-20.85-65.527.408-6.966 12.017-143.36 19.435-230.17.309-3.611.466-5.692 5.3-5.347 5.184.37 5.612-1.727 3.54-7.77-3.737-10.9-5.649-24.2-5.06-31.068 1.369-15.987 2.231-26.008 2.297-26.732 1.804-19.481 7.9-39.11 33.93-52.707 14.168-7.4 25.64-9.712 43.9-11.266z",
  Silverstone:
    "M187.132 258.577c2.83-3.815 6.413-9.565 13.577-10.593 13.554-1.944 21.828 1.404 35.111 3.348 16.012 2.344 24.823-.431 33.316-6.912 16.091-12.281 27.87-21.819 38.54-30.677 7.154-5.938 13.066-1.296 14.154 3.024 1.523 6.05 2.831 11.45 6.969 24.844 1.656 5.362 9.362 7.346 12.628.432 5.003-10.589 6.313-15.666 7.839-21.819 5.617-22.642-.695-28.128-2.83-30.029-29.832-26.571-120.874-108.733-128.253-115.577-10.017-9.29-28.416-4.536-29.233 4.861-.816 9.398-.899 12.315-1.306 17.985-.25 3.466-7.266 17.717-20.74 12.8-14.209-5.185-7.879-20.646-7.325-21.701 7.29-13.886 15.623-29.211 20.505-37.048 9.58-15.378 25.704-25.296 39.407-26.584 18.917-1.78 76.237-6.805 105.634-9.258 2.916-.243 5.556-.498 7.862-.65 7.843-.516 21.345 4.846 24.827 16.658 8.166 27.706 12.928 43.496 14.332 67.407 1.269 21.603 2.421 42.276 2.653 49.736.278 8.92 1.882 13.375 9.635 24.627.68.984 1.46 2.099 2.315 3.333 2.182 3.148 3.236 7.36-.247 16.434-3.793 9.88-9.554 20.467-9.145 29.812.546 12.475 4.325 13.683 9.363 19.66 10.017 11.882 7.186 25.707-4.62 32.755-4.323 2.58-8.564 4.969-12.364 7.211-9.437 5.57-13.513 9.501-18.29 19.28-12.957 26.518-83.893 152.682-99.075 173.203-12.588 17.013-38.433 10.532-43.659-6.643-1.42-4.666-16.26-30.392-20.577-34.403-10.234-9.505-16.766-16.417-20.25-21.17-3.42-4.668-7.676-9.398-13.882-17.337-2.815-3.6-6.621-5.117-10.615-.81-3.291 3.549-5.422 5.822-7.408 7.183-2.547 1.745-8.378 1.89-11.644-1.998-1.713-2.04-10.749-12.65-14.154-22.035-3.919-10.802-5.688-12.142 5.771-27.113 10.997-14.365 52.26-67.725 59.227-76.475 2.784-3.497 7.22-9.384 11.952-15.761z",
  "Spa-Francorchamps":
    "M167.75 20.858c-3.075-5.364-.283-7.034 3.387-5.065 3.669 1.97 49.393 30.95 55.603 35.171 6.21 4.22 10.613 8.816 14.395 13.224 6.116 7.128 29.072 34.701 33.87 40.235 2.327 2.682 4.765 5.265 8.892 6.504.742.223 1.542.375 2.398.53 3.105.563 9.733 2.517 14.112 9.848 4.987 8.348 5.552 11.818 4.705 22.04-.49 5.916.164 11.615 2.258 14.631 5.08 7.316 15.721 22.54 22.956 32.545 8.75 12.099 16.935 28.98 20.322 40.235s41.49 144.622 43.467 152.5c1.975 7.878 4.009 9.705-5.504 15.334-4.516 2.673-8.435 6.431-6.774 13.787 1.27 5.628 9.744 26.446.846 32.639-2.08 1.447-48.41 32.702-57.014 38.265-5.222 3.377-12.385.885-15.242-4.08-2.856-4.964-3.503-11.631 4.093-15.897 5.927-3.329 9.314-5.205 25.685-14.96 3.995-2.38 6.181-7.751 3.198-14.442-2.634-5.909-7.55-20.755-9.972-27.574-5.645-15.897-10.43-48.422-14.254-69.216-1.552-8.44-7.338-16.882-19.193-18.007-2.61-.248-11.29-.844-18.77-.563-7.303.275-20.816 4.787-27.66 22.79-5.08 13.366-15.524 40.095-23.992 62.464-6.59 17.407-22.297 12.661-24.696 10.832-5.53-4.215-19.68-14.49-31.19 1.688-5.503 7.738-16.934 26.59-23.567 36.86-7.403 11.462-15.806 3.657-38.81-13.506-9.759-7.282-7.215-21.806-5.786-27.293 6.586-25.285 18.77-40.094 31.189-50.786s29.919-23.353 50.805-30.669c20.887-7.315 27.2-13.496 33.023-24.197 16.23-29.825 24.133-42.908 22.44-57.54-1.694-14.63-19.053-43.752-22.722-56.413-2.69-9.285-4.774-32.872-5.249-52.615-.083-3.47-.676-7.138 6.096-6.19 10.725 1.5 7.765-7.127 6.21-9.379-7.904-11.442-11.323-16.99-17.782-28.324-7.057-12.38-39.515-71.467-41.773-75.406z",
  Singapore:
    "M461.432 325.308c3.546.215 6.228-.46 8.285-3.467 2.658-3.883 10.644-15.694 13.506-20.689 2.248-3.924 1.906-8.228 1.362-12.25-.547-4.022-21.779-162.674-22.394-167.042-.55-3.905-2.982-6.455-8.02-5.625-5.037.832-10.535.682-15.509-2.08-5.826-3.236-7.566-5.548-9.382-9.324-2.012-4.185-5.031-6.738-7.791-6.78-4.919-.079-7.416 3.389-7.87 6.78-.944 7.05-1.516 14.7-1.89 19.263-.454 5.547.59 16.212 1.816 20.65s6.726 21.596 9.38 32.207c2.657 10.608 5.068 21.644 6.355 28.2 1.816 9.246-5.447 26.66-19.82 25.58-16.56-1.243-96.96-6.878-104.994-7.571-7.76-.67-17.023-1.387-24.511-4.784-9.874-4.479-92.876-54.296-99.618-58.388-4.267-2.589-5.307-2.724-7.762 1.528-11.374 19.692-20.682 35.827-31.12 56.305-1.838 3.606-3.541 4.266-6.334 1.284-4.19-4.477-26.419-27.808-32.683-34.534-5.78-6.204-20.57-6.21-25.67 4.612-6.504 13.799-56.755 104.28-59.206 108.974-1.382 2.644-2.983 6.481-2.427 10.392.47 3.318 2.756 6.781 5.287 8.641 3.575 2.63 8.469 6.402 12.552 9.457 2.35 1.759 5.615 2.859 10.003 3.783 3.281.692 4.549 2.145 4.69 10.942.077 4.74.304 10.324.304 14.178 0 5.64 3.442 6.28 6.278 8.59 8.916 7.264 16.457 13.176 21.79 17.106 1.07.79 6.672 4.662 8.285 7.396 3.404 5.78 5.447 8.784 7.15 11.096 2.722 3.694 7.75 2.688 8.625-2.08 1.93-10.519 14.526-87.49 17.477-105.29.646-3.9 2.514-10.388 3.065-11.788.098-.25 17.789-43.744 18.355-45.218.646-1.68 1.17-2.659 1.277-2.918 1.153-2.766 3.802-3.986 7.49-.75 5.372 4.713 45.155 39.55 51.182 44.959 5.529 4.963 13.647 8.282 20.848 8.815 2.986.222 39.063 1.437 74.063 3.358 33.248 1.827 65.538 4.368 67.03 4.47 3.065.208 6.169 2.43 6.129 6.819-.115 12.367 4.653 19.533 14.98 20.457 5.903.526 74.874 4.459 79.437 4.736z",
};

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
    <svg className="track-map" viewBox={TRACK_VIEWBOX} role="img" aria-label={`${trackName} circuit map with live car position`}>
      <path className="track-shadow" d={d} />
      <path ref={pathRef} className="track-line" d={d} />
      <g className="track-dots">
        {dots.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={7} />
        ))}
        <circle className="our-dot" cx={marker.x} cy={marker.y} r={12} />
      </g>
    </svg>
  );
}

function StandingsRail({ rows }: { rows: StandingRow[] }) {
  return (
    <div className="standings-rail">
      <div className="standings-head"><span>LIVE</span><span>INTERVAL</span></div>
      <div className="standings-list">
        {rows.map((r) => (
          <div key={r.pos} className={`standing-row ${r.isUs ? "us" : ""}`}>
            <span className="pos">P{r.pos}</span>
            <span className="car">{r.car}</span>
            <span className="gap">{r.gapToLeader}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function VehiclePanel({
  lap,
  thermalWarning,
  paceValues,
  wearValues,
  puValues,
}: {
  lap: LapTelemetry | null;
  thermalWarning: boolean;
  paceValues: number[];
  wearValues: number[];
  puValues: number[];
}) {
  if (!lap) return null;
  return (
    <section className="vehicle-panel panel" aria-labelledby="vehicle-title">
      <div className="section-kicker">
        <span className="status-dot" /> {lap.driver} · VEHICLE STATE <b>LAP {String(lap.lap).padStart(3, "0")}</b>
      </div>
      <h1 id="vehicle-title" className="sr-only">Live vehicle state</h1>
      <div className="car-stage">
        <div className="car-aura" />
        <CarModel3D telemetry={lap} enabled={CAR_3D_ENABLED} />
      </div>
      <div className="stat-strip">
        {(() => {
          const est = new Set(lap.estimated_fields ?? []);
          const tag = (field: string) => (est.has(field) ? " (EST.)" : "");
          return (
            <>
              <div className="stat-chip"><span>FL TYRE{tag("tire_wear_pct")}</span><strong>{lap.tire_temps_c.FL}°C · {lap.tire_wear_pct.FL}%</strong></div>
              <div className="stat-chip"><span>FR TYRE{tag("tire_wear_pct")}</span><strong>{lap.tire_temps_c.FR}°C · {lap.tire_wear_pct.FR}%</strong></div>
              <div className="stat-chip"><span>RL TYRE{tag("tire_wear_pct")}</span><strong>{lap.tire_temps_c.RL}°C · {lap.tire_wear_pct.RL}%</strong></div>
              <div className="stat-chip"><span>RR TYRE{tag("tire_wear_pct")}</span><strong>{lap.tire_temps_c.RR}°C · {lap.tire_wear_pct.RR}%</strong></div>
              <div className={`stat-chip ${thermalWarning ? "warning" : ""}`}><span>POWER UNIT{tag("engine_temp_c")}</span><strong>{lap.engine_temp_c}°C · {thermalWarning ? "HIGH" : "NOMINAL"}</strong></div>
              <div className="stat-chip"><span>BRAKES{tag("brake_temp_c")}</span><strong>{lap.brake_temp_c}°C</strong></div>
              <div className="stat-chip"><span>ENERGY{tag("energy_pct")}</span><strong>{lap.energy_pct}%</strong></div>
              <div className="stat-chip"><span>FUEL{tag("fuel_kg")}</span><strong>{lap.fuel_kg} kg</strong></div>
            </>
          );
        })()}
      </div>
      <div className="chart-grid">
        <LineChart title="PACE" unit="s" value={lap.lap_time_sec.toFixed(1)} path={buildSparkPath(paceValues)} lapLabel={`L${lap.lap}`} />
        <LineChart title="TYRE DEG" unit="%" value={String(Math.max(lap.tire_wear_pct.FL, lap.tire_wear_pct.FR, lap.tire_wear_pct.RL, lap.tire_wear_pct.RR))} amber path={buildSparkPath(wearValues)} lapLabel={`L${lap.lap}`} />
        <LineChart title="POWER UNIT" unit="°C" value={String(lap.engine_temp_c)} amber={thermalWarning} path={buildSparkPath(puValues)} lapLabel={`L${lap.lap}`} />
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
  const currentAudio = useRef<HTMLAudioElement | null>(null);
  // Laps can land faster than a TTS round-trip completes. Without these, two
  // in-flight requests both resolve and play, and the callouts talk over
  // each other — only the newest call should ever be heard.
  const speakSeq = useRef(0);
  const speakAbort = useRef<AbortController | null>(null);

  const speak = useCallback(async (text: string) => {
    const seq = ++speakSeq.current;
    currentAudio.current?.pause();
    speakAbort.current?.abort(); // drop the superseded request instead of paying for audio we'll discard
    const controller = new AbortController();
    speakAbort.current = controller;
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!res.ok) return; // fail silently — voice is a nice-to-have, not core functionality
      const blob = await res.blob();
      if (seq !== speakSeq.current) return; // a newer callout won while we were fetching
      currentAudio.current?.pause();
      const audio = new Audio(URL.createObjectURL(blob));
      currentAudio.current = audio;
      // Autoplay is blocked until the user has interacted with the page; the
      // rejection is expected, not an error worth surfacing.
      audio.play().catch(() => { });
    } catch {
      // aborted or network hiccup — don't block the dashboard on voice
    }
  }, []);

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
      if (voiceOn && json.decision?.call) {
        const { label, sub } = parseCallLabel(json.decision.call);
        void speak(formatSpeechText(`${label}. ${sub}`));
      }
      return json;
    },
    [deriveEvents, voiceOn, speak],
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
  const syntheticStandings = useMemo(() => (lastLap ? buildStandings(lastLap, 8, 20) : []), [lastLap]);
  const standings = data?.standings ?? syntheticStandings;
  const isReal = Boolean(meta?.is_real);

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand"><strong>PIT<span>//</span>CALL</strong><small>Pit Happens</small></div>
        <div className="session-meta">
          <span className="live-pill"><i /> LIVE</span>
          {isReal && <span className="real-badge" title={meta?.data_note}>REAL DATA</span>}
          <span>{(meta?.track ?? "—").toUpperCase()} · {(meta?.session ?? "—").toUpperCase()}</span>
          <span>LAP <b>{progress?.current_lap ?? "—"}</b> / {progress?.total_laps ?? "—"}</span>
          <span className="clock">{clock}</span>
        </div>
        <button
          className="stream-toggle voice"
          onClick={() => {
            setVoiceOn((v) => !v);
            currentAudio.current?.pause();
          }}
          aria-label="Toggle voice"
        >
          {voiceOn ? "🔊 VOICE" : "🔇 VOICE"}
        </button>
        <button className={`stream-toggle ${running ? "" : "paused"}`} onClick={toggleRunning} aria-label={running ? "Pause telemetry" : "Resume telemetry"}>
          {running ? "PAUSE" : "RESUME"}
        </button>
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
        <VehiclePanel
          lap={data?.latest_lap ?? null}
          thermalWarning={thermalWarning}
          paceValues={paceValues}
          wearValues={wearValues}
          puValues={puValues}
        />
        <section className="right-rail">
          <div className="race-context panel">
            <div className="track-wrap"><TrackMap trackName={meta?.track ?? "Monza"} progressFrac={progressFrac} /></div>
            <div className="side-column">
              <div className="weather-block">
                <div><span className="weather-icon thermometer" /><p><small>TRACK</small><strong>{meta?.weather.track_c ?? "—"}°C</strong></p></div>
                <div><span className="weather-icon cloud" /><p><small>AIR</small><strong>{meta?.weather.air_c ?? "—"}°C</strong></p></div>
                <div><span className="weather-icon" /><p><small>CONDITION</small><strong>{(meta?.weather.condition ?? "—").toUpperCase()}</strong></p></div>
                <div><span className="weather-icon wind" /><p><small>WIND</small><strong>{meta?.weather.wind_kmh ?? "—"} km/h</strong></p></div>
                <div><span className="weather-icon timer" /><p><small>PIT LOSS</small><strong>{meta?.pit_stop_loss_sec ?? "—"}s</strong></p></div>
              </div>
              {standings.length > 0 && <StandingsRail rows={standings} />}
              <EventFeed events={events} />
            </div>
          </div>
          <StrategyPanel data={data} loading={loading} sent={sent} onSend={() => setSent(true)} />
        </section>
      </div>
    </main>
  );
}

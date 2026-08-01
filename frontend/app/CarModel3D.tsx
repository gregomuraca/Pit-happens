"use client";

// Live 3D car with thermal shading, driven by telemetry.
//
// The model is embed-only (not downloadable), so it runs inside Sketchfab's
// viewer rather than our own three.js scene. A bare <iframe> would be useless
// here — it is cross-origin and sandboxed, so nothing inside could react to
// telemetry. The Viewer API gives us a scene handle we can recolour.
//
// Anything external can fail on demo wifi, so every failure path falls back to
// the static PNG: the centrepiece panel degrades instead of going blank.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// "2020 Tatuus FT-60" by Dave Love, CC Attribution —
// https://sketchfab.com/3d-models/2020-tatuus-ft-60-41c932d44ed94b1cb19100580e440aba
//
// Sketchfab exposes materialCount but never material *names*, so whether a
// model's parts can be shaded is only knowable by loading it. Hence the
// override below: trying a candidate costs a reload, not a code change.
//   ?model=<32-hex-uid>          one-off trial
//   NEXT_PUBLIC_CAR_3D_UID=<uid> pin a different model
const DEFAULT_MODEL_UID = "41c932d44ed94b1cb19100580e440aba";
const VIEWER_API = "https://static.sketchfab.com/api/sketchfab-viewer-1.12.1.js";

function resolveModelUid(): string {
  if (typeof window !== "undefined") {
    const q = new URLSearchParams(window.location.search).get("model");
    if (q && /^[0-9a-f]{32}$/i.test(q)) return q;
  }
  return process.env.NEXT_PUBLIC_CAR_3D_UID || DEFAULT_MODEL_UID;
}

// If the viewer has not reported ready by now, assume it never will.
const READY_TIMEOUT_MS = 9000;

const CORNER_KEYS = ["FL", "FR", "RL", "RR"] as const;
type Corner = (typeof CORNER_KEYS)[number];

export interface ThermalTelemetry {
  tire_temps_c?: Partial<Record<Corner, number>> | null;
  brake_temp_c?: number | null;
  engine_temp_c?: number | null;
}

// Which corner a material belongs to, if its name says so. Many models use a
// single shared rubber material, in which case nothing matches and we drive
// every tyre from the hottest corner instead.
const CORNER_HINTS: Record<Corner, RegExp> = {
  FL: /(^|[^a-z])(fl|front[_ -]?left)([^a-z]|$)/i,
  FR: /(^|[^a-z])(fr|front[_ -]?right)([^a-z]|$)/i,
  RL: /(^|[^a-z])(rl|rear[_ -]?left)([^a-z]|$)/i,
  RR: /(^|[^a-z])(rr|rear[_ -]?right)([^a-z]|$)/i,
};

/**
 * A group of materials shaded by one telemetry channel. Ranges are the
 * operating windows the tools in `tools.py` already reason about, so the
 * colour and the pit call agree about what "hot" means.
 */
interface HeatGroup {
  id: "tyre" | "brake" | "engine";
  label: string;
  match: RegExp;
  cold: number;
  hot: number;
  /** Peak emissive strength — brakes and exhausts genuinely glow, rubber does not. */
  glow: number;
}

const HEAT_GROUPS: HeatGroup[] = [
  {
    id: "tyre",
    label: "TYRE",
    match: /tyre|tire|rubber|slick|tread|pirelli|goodyear|michelin|hankook/i,
    cold: 85,
    hot: 125,
    glow: 0.35,
  },
  {
    id: "brake",
    label: "BRAKE",
    match: /brake|disc|disk|rotor|caliper|brembo/i,
    cold: 350,
    hot: 950,
    glow: 1.0,
  },
  {
    id: "engine",
    label: "ENGINE",
    match: /engine|motor|power[_ -]?unit|\bpu\b|exhaust|pipe|header|manifold|turbo|radiator|intake|sidepod/i,
    cold: 95,
    hot: 135,
    glow: 0.8,
  },
];

// Wheel rims and bodywork often contain "wheel"/"cover"; without this they get
// shaded as rubber and the whole car turns red.
const NOT_TYRE = /rim|hub|spoke|nut|cover|body|paint|carbon|glass|decal/i;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Cold → glowing red, returned linear (Sketchfab expects linear, not sRGB). */
function heatColor(t: number): [number, number, number] {
  const f = clamp01(t);
  const srgb: [number, number, number] = [0.09 + 0.86 * f, 0.09 + 0.1 * (1 - f), 0.1 + 0.1 * (1 - f)];
  return srgb.map((c) => Math.pow(c, 2.2)) as [number, number, number];
}

function heatCss(t: number): string {
  const f = clamp01(t);
  return `hsl(${Math.round(32 - 32 * f)}, ${Math.round(52 + 48 * f)}%, ${Math.round(58 - 11 * f)}%)`;
}

let scriptPromise: Promise<void> | null = null;
function loadViewerApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("ssr"));
  const w = window as unknown as { Sketchfab?: unknown };
  if (w.Sketchfab) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = VIEWER_API;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      scriptPromise = null; // let a later mount retry
      reject(new Error("sketchfab viewer api failed to load"));
    };
    document.head.appendChild(el);
  });
  return scriptPromise;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface ShadedMaterial {
  material: any;
  group: HeatGroup;
  corner: Corner | null;
}

export default function CarModel3D({
  telemetry,
  enabled = true,
}: {
  telemetry?: ThermalTelemetry | null;
  enabled?: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const apiRef = useRef<any>(null);
  const shadedRef = useRef<ShadedMaterial[]>([]);
  const lastAppliedRef = useRef<Map<string, number>>(new Map());
  const [mode, setMode] = useState<"loading" | "live" | "fallback">(enabled ? "loading" : "fallback");
  const [groupsFound, setGroupsFound] = useState<Record<string, number>>({});

  const fallback = useCallback((why: string) => {
    // Visuals are nice-to-have; never let them take the panel down.
    console.warn(`[car3d] falling back to static image: ${why}`);
    setMode("fallback");
  }, []);

  const tyre = telemetry?.tire_temps_c ?? null;
  const brake = telemetry?.brake_temp_c ?? null;
  const engine = telemetry?.engine_temp_c ?? null;

  /** Normalised 0..1 heat per group, plus per-corner detail for tyres. */
  const heat = useMemo(() => {
    const temps = CORNER_KEYS.map((c) => tyre?.[c]).filter((v): v is number => typeof v === "number");
    const hottestTyre = temps.length ? Math.max(...temps) : null;
    const norm = (v: number | null, g: HeatGroup) => (v === null ? null : clamp01((v - g.cold) / (g.hot - g.cold)));
    return {
      tyre: norm(hottestTyre, HEAT_GROUPS[0]),
      brake: norm(brake, HEAT_GROUPS[1]),
      engine: norm(engine, HEAT_GROUPS[2]),
      hottestTyre,
    };
  }, [tyre, brake, engine]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled && !apiRef.current) fallback("viewer did not become ready in time");
    }, READY_TIMEOUT_MS);

    loadViewerApi()
      .then(() => {
        if (cancelled || !iframeRef.current) return;
        const Sketchfab = (window as any).Sketchfab;
        if (!Sketchfab) return fallback("viewer api missing after load");

        const uid = resolveModelUid();
        console.info(`[car3d] loading model ${uid}`);
        new Sketchfab(iframeRef.current).init(uid, {
          autostart: 1,
          preload: 1,
          transparent: 1,
          ui_infos: 0,
          ui_controls: 0,
          ui_stop: 0,
          ui_hint: 0,
          ui_watermark_link: 0,
          success: (api: any) => {
            if (cancelled) return;
            api.start();
            api.addEventListener("viewerready", () => {
              if (cancelled) return;
              apiRef.current = api;
              api.getMaterialList((err: unknown, materials: any[]) => {
                if (err || !materials) return;
                // Surfaced deliberately: the real names decide how much of the
                // car we can actually shade.
                const names = materials.map((m) => m.name);
                console.info("[car3d] materials:", names);
                // Parked on window so the names can be copied in one step when
                // the heuristics below fail to match this artist's naming.
                (window as any).__car3dMaterials = names;
                (window as any).__car3dChannels = materials.map((m) => ({
                  name: m.name,
                  channels: Object.keys(m.channels ?? {}),
                }));

                const shaded: ShadedMaterial[] = [];
                const counts: Record<string, number> = {};
                for (const m of materials) {
                  const name = m.name ?? "";
                  for (const group of HEAT_GROUPS) {
                    if (!group.match.test(name)) continue;
                    if (group.id === "tyre" && NOT_TYRE.test(name)) continue;
                    const corner =
                      group.id === "tyre" ? CORNER_KEYS.find((c) => CORNER_HINTS[c].test(name)) ?? null : null;
                    shaded.push({ material: m, group, corner });
                    counts[group.id] = (counts[group.id] ?? 0) + 1;
                    break; // first matching group wins
                  }
                }
                shadedRef.current = shaded;
                setGroupsFound(counts);
                console.info(
                  "[car3d] shaded materials by group:",
                  counts,
                  "| per-corner tyres:",
                  shaded.some((s) => s.corner) ? "yes" : "no (shared material)",
                );
              });
              setMode("live");
            });
          },
          error: () => fallback("viewer reported an error"),
        });
      })
      .catch((e) => fallback(String(e)));

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      apiRef.current = null;
      shadedRef.current = [];
      lastAppliedRef.current.clear();
    };
  }, [enabled, fallback]);

  // Push temperatures into the scene.
  useEffect(() => {
    const api = apiRef.current;
    if (!api || shadedRef.current.length === 0) return;

    for (const { material, group, corner } of shadedRef.current) {
      let t: number | null;
      if (group.id === "tyre") {
        const cornerTemp = corner && tyre ? tyre[corner] : undefined;
        t = typeof cornerTemp === "number" ? clamp01((cornerTemp - group.cold) / (group.hot - group.cold)) : heat.tyre;
      } else {
        t = heat[group.id];
      }
      if (t === null || t === undefined) continue;

      // setMaterial round-trips into the viewer; skip imperceptible changes so
      // a fast telemetry stream cannot flood it.
      const key = `${group.id}:${material.id ?? material.name}:${corner ?? ""}`;
      const quantised = Math.round(t * 40) / 40;
      if (lastAppliedRef.current.get(key) === quantised) continue;
      lastAppliedRef.current.set(key, quantised);

      const color = heatColor(quantised);
      if (material.channels?.AlbedoPBR) {
        material.channels.AlbedoPBR.color = color;
        material.channels.AlbedoPBR.enable = true;
      }
      if (material.channels?.DiffuseColor) {
        material.channels.DiffuseColor.color = color;
        material.channels.DiffuseColor.enable = true;
      }
      // Emissive is what sells "glowing hot" — brake discs and exhausts light
      // up, rubber only smoulders.
      if (material.channels?.EmitColor) {
        material.channels.EmitColor.color = color;
        material.channels.EmitColor.factor = quantised * group.glow;
        material.channels.EmitColor.enable = quantised > 0.03;
      }
      api.setMaterial(material, () => {});
    }
  }, [tyre, heat]);

  const readout = (label: string, value: number | null | undefined, t: number | null, unit = "°") => (
    <span className="heat-chip" key={label}>
      <i style={{ background: t === null ? "#4b5861" : heatCss(t), color: t === null ? "#4b5861" : heatCss(t) }} />
      {label} <b>{typeof value === "number" ? `${Math.round(value)}${unit}` : "—"}</b>
    </span>
  );

  return (
    <>
      {enabled && mode !== "fallback" && (
        <iframe
          ref={iframeRef}
          className="car-viewer"
          title="Live 3D car model with thermal shading"
          allow="autoplay; fullscreen; xr-spatial-tracking"
        />
      )}
      {mode === "fallback" && (
        <img
          className="formula-car"
          src="/formula-car.png"
          alt="Unbranded graphite Formula-style racing car viewed from above"
        />
      )}

      {/* Readouts are anchored to the stage, not to the model, so they stay
          correct no matter how the viewer camera is orbited. */}
      {telemetry && (
        <>
          <div className="tyre-readouts" aria-label="Tyre temperatures">
            {CORNER_KEYS.map((c) => {
              const v = tyre?.[c];
              const t = typeof v === "number" ? clamp01((v - HEAT_GROUPS[0].cold) / (HEAT_GROUPS[0].hot - HEAT_GROUPS[0].cold)) : null;
              return (
                <span key={c} className={`heat-chip tyre-${c.toLowerCase()}`}>
                  <i style={{ background: t === null ? "#4b5861" : heatCss(t) }} />
                  {c} <b>{typeof v === "number" ? `${Math.round(v)}°` : "—"}</b>
                </span>
              );
            })}
          </div>
          <div className="heat-readouts">
            {readout("BRAKE", brake, heat.brake)}
            {readout("ENGINE", engine, heat.engine)}
          </div>
        </>
      )}

      {mode === "loading" && <span className="car-viewer-status">LOADING 3D MODEL…</span>}
      {mode === "live" && Object.keys(groupsFound).length === 0 && (
        <span className="car-viewer-status subtle">MODEL LOADED · NO SHADEABLE PARTS MATCHED</span>
      )}
    </>
  );
}

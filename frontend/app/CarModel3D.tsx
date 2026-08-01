"use client";

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { useEffect, useMemo, useRef, useState } from "react";

const MODEL_URL = "/models/2026_red_bull_racing_rb22/scene.gltf";
const CORNER_KEYS = ["FL", "FR", "RL", "RR"] as const;
type Corner = (typeof CORNER_KEYS)[number];
type HeatGroup = "tyre" | "brake" | "engine";

export interface ThermalTelemetry {
    tire_temps_c?: Partial<Record<Corner, number>> | null;
    brake_temp_c?: number | null;
    engine_temp_c?: number | null;
}

interface ShadedMaterial {
    material: THREE.MeshStandardMaterial & {
        color: THREE.Color;
        emissive: THREE.Color;
        emissiveIntensity: number;
    };
    baseColor: THREE.Color;
    baseEmissive: THREE.Color;
    baseEmissiveIntensity: number;
    baseRoughness: number | undefined;
    baseMetalness: number | undefined;
    group: HeatGroup;
    corner: Corner | null;
}

type GLTF = {
    scene: THREE.Group;
};

const GROUP_MATCHERS: Record<HeatGroup, RegExp> = {
    tyre: /tire|tyre|rubber|slick|tread|wheel|hub/i,
    brake: /brake|disc|disk|rotor|caliper/i,
    engine: /engine|motor|power[_ -]?unit|\bpu\b|exhaust|pipe|header|manifold|turbo|radiator|intake|sidepod/i,
};

const CORNER_HINTS: Record<Corner, RegExp> = {
    FL: /(^|[^a-z])(fl|lf|front[_ -]?(left|lf)|left[_ -]?(front|front[_ -]?left))([^a-z]|$)/i,
    FR: /(^|[^a-z])(fr|rf|front[_ -]?(right|rf)|right[_ -]?(front|front[_ -]?right))([^a-z]|$)/i,
    RL: /(^|[^a-z])(rl|lr|rear[_ -]?(left|lr)|back[_ -]?(left|lr)|left[_ -]?(rear|back)|bl)([^a-z]|$)/i,
    RR: /(^|[^a-z])(rr|rear[_ -]?(right|rr)|back[_ -]?(right|rr)|right[_ -]?(rear|back)|br)([^a-z]|$)/i,
};

const NOT_TYRE = /rim|spoke|nut|body|paint|carbon|glass|decal|halo|wing|cockpit|seat/i;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function heatColor(t: number): THREE.Color {
    const value = clamp01(t);
    if (value >= 0.8) return new THREE.Color(0xff3b1f);
    if (value >= 0.22) return new THREE.Color(0xff8f1f);
    if (value >= 0.12) return new THREE.Color(0x6b5b48);
    return new THREE.Color(0x121417);
}

function heatCss(t: number): string {
    const value = clamp01(t);
    return `hsl(${Math.round(32 - 32 * value)}, ${Math.round(52 + 48 * value)}%, ${Math.round(58 - 11 * value)}%)`;
}

function quantiseHeat(value: number | null): number | null {
    if (value === null) return null;
    return Math.round(clamp01(value) * 40) / 40;
}

function resolveCorner(text: string): Corner | null {
    const normalized = text.replace(/_/g, " ");
    for (const corner of CORNER_KEYS) {
        if (CORNER_HINTS[corner].test(text) || CORNER_HINTS[corner].test(normalized)) return corner;
    }
    return null;
}

function classifyGroup(text: string): HeatGroup | null {
    for (const [group, matcher] of Object.entries(GROUP_MATCHERS) as Array<[HeatGroup, RegExp]>) {
        if (matcher.test(text)) return group;
    }
    return null;
}

function ancestorNames(object: THREE.Object3D): string[] {
    const names: string[] = [];
    let current: THREE.Object3D | null = object;
    while (current) {
        if (current.name) names.push(current.name);
        current = current.parent;
    }
    return names;
}

function isMesh(object: THREE.Object3D): object is THREE.Mesh {
    return (object as THREE.Mesh).isMesh === true;
}

export default function CarModel3D({
    telemetry,
    enabled = true,
}: {
    telemetry?: ThermalTelemetry | null;
    enabled?: boolean;
}) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const modelRootRef = useRef<THREE.Group | null>(null);
    const shadedRef = useRef<ShadedMaterial[]>([]);
    const lastAppliedRef = useRef<Map<string, number>>(new Map());
    const frameRef = useRef<number | null>(null);
    const dragRef = useRef({ active: false, x: 0, y: 0 });
    const orbitRef = useRef({ yaw: 0.7, pitch: -0.08, distance: 7.6 });
    const idleSinceRef = useRef(performance.now());
    const [mode, setMode] = useState<"loading" | "live" | "fallback">(enabled ? "loading" : "fallback");
    const [matchedCounts, setMatchedCounts] = useState<Record<string, number>>({});

    const tyreTemps = telemetry?.tire_temps_c ?? null;
    const brakeTemp = telemetry?.brake_temp_c ?? null;
    const engineTemp = telemetry?.engine_temp_c ?? null;

    const heat = useMemo(() => {
        const temps = CORNER_KEYS.map((corner) => tyreTemps?.[corner]).filter((value): value is number => typeof value === "number");
        const hottestTyre = temps.length ? Math.max(...temps) : null;
        const tyre = hottestTyre === null ? null : clamp01((hottestTyre - 85) / (125 - 85));
        const brake = brakeTemp === null ? null : clamp01((brakeTemp - 350) / (950 - 350));
        const engine = engineTemp === null ? null : clamp01((engineTemp - 95) / (135 - 95));
        return { tyre, brake, engine, hottestTyre };
    }, [tyreTemps, brakeTemp, engineTemp]);

    useEffect(() => {
        if (!enabled) setMode("fallback");
    }, [enabled]);

    useEffect(() => {
        const host = hostRef.current;
        const canvas = canvasRef.current;
        if (!host || !canvas || !enabled) return;

        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.25;
        rendererRef.current = renderer;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x101924);
        scene.fog = new THREE.Fog(0x101924, 8, 20);
        sceneRef.current = scene;

        const ambientLight = new THREE.AmbientLight(0xa9c7d8, 0.58);
        scene.add(ambientLight);

        const hemiLight = new THREE.HemisphereLight(0xb7e6ff, 0x11171d, 1.1);
        hemiLight.position.set(0, 8, 0);
        scene.add(hemiLight);

        const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
        camera.position.set(0, 1.6, 7.8);
        cameraRef.current = camera;

        const keyLight = new THREE.DirectionalLight(0xc8f6ff, 1.35);
        keyLight.position.set(4, 6, 5);
        scene.add(keyLight);

        const fillLight = new THREE.DirectionalLight(0xffffff, 0.8);
        fillLight.position.set(-4, 3, -3);
        scene.add(fillLight);

        const rimLight = new THREE.PointLight(0x19d3e6, 4.2, 22, 2);
        rimLight.position.set(0, 1.2, 0);
        scene.add(rimLight);

        const modelRoot = new THREE.Group();
        scene.add(modelRoot);
        modelRootRef.current = modelRoot;

        const resize = () => {
            const width = host.clientWidth;
            const height = host.clientHeight;
            if (!width || !height) return;
            renderer.setSize(width, height, false);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
        };
        resize();

        const updateCamera = () => {
            const { yaw, pitch, distance } = orbitRef.current;
            const clampedPitch = THREE.MathUtils.clamp(pitch, -0.7, 0.55);
            orbitRef.current.pitch = clampedPitch;
            camera.position.set(
                Math.sin(yaw) * distance,
                Math.sin(clampedPitch) * distance,
                Math.cos(yaw) * distance,
            );
            camera.lookAt(0, 0.75, 0);
        };

        const setDragging = (active: boolean) => {
            dragRef.current.active = active;
            idleSinceRef.current = performance.now();
        };

        const onPointerDown = (event: PointerEvent) => {
            setDragging(true);
            dragRef.current.x = event.clientX;
            dragRef.current.y = event.clientY;
            host.setPointerCapture(event.pointerId);
        };

        const onPointerMove = (event: PointerEvent) => {
            if (!dragRef.current.active) return;
            const dx = event.clientX - dragRef.current.x;
            const dy = event.clientY - dragRef.current.y;
            dragRef.current.x = event.clientX;
            dragRef.current.y = event.clientY;
            orbitRef.current.yaw += dx * 0.01;
            orbitRef.current.pitch += dy * 0.004;
            idleSinceRef.current = performance.now();
            updateCamera();
        };

        const onPointerUp = (event: PointerEvent) => {
            setDragging(false);
            if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
        };

        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            orbitRef.current.distance = THREE.MathUtils.clamp(orbitRef.current.distance + event.deltaY * 0.004, 5.5, 10.8);
            idleSinceRef.current = performance.now();
            updateCamera();
        };

        host.addEventListener("pointerdown", onPointerDown);
        host.addEventListener("pointermove", onPointerMove);
        host.addEventListener("pointerup", onPointerUp);
        host.addEventListener("pointerleave", onPointerUp);
        host.addEventListener("wheel", onWheel, { passive: false });

        const ro = new ResizeObserver(resize);
        ro.observe(host);
        updateCamera();

        const clearModel = () => {
            shadedRef.current = [];
            lastAppliedRef.current.clear();
            if (!modelRootRef.current) return;
            modelRootRef.current.traverse((obj: THREE.Object3D) => {
                if (isMesh(obj)) {
                    const mesh = obj as THREE.Mesh;
                    mesh.geometry.dispose();
                    if (Array.isArray(mesh.material)) {
                        mesh.material.forEach((material: THREE.Material) => material.dispose());
                    } else {
                        mesh.material.dispose();
                    }
                }
            });
            modelRootRef.current.clear();
        };

        const loader = new GLTFLoader();
        loader.load(
            MODEL_URL,
            (gltf: GLTF) => {
                const model = gltf.scene;
                const box = new THREE.Box3().setFromObject(model);
                const size = new THREE.Vector3();
                const center = new THREE.Vector3();
                box.getSize(size);
                box.getCenter(center);
                model.position.sub(center);

                const longestSide = Math.max(size.x, size.y, size.z) || 1;
                model.scale.setScalar(5.2 / longestSide);

                const fittedBox = new THREE.Box3().setFromObject(model);
                model.position.y -= fittedBox.min.y;
                model.position.y += 0.12;
                model.rotation.y = Math.PI;

                const shaded: ShadedMaterial[] = [];
                const counts: Record<string, number> = {};

                model.traverse((obj: THREE.Object3D) => {
                    if (!isMesh(obj)) return;
                    const mesh = obj as THREE.Mesh;
                    obj.castShadow = false;
                    obj.receiveShadow = false;

                    const names = ancestorNames(mesh).join(" ");
                    const corner = resolveCorner(names);
                    const group = classifyGroup(
                        `${mesh.name} ${names} ${(Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((material: THREE.Material) => material.name).join(" ")}`,
                    );
                    if (!group) return;
                    if (group === "tyre" && NOT_TYRE.test(`${mesh.name} ${names}`)) return;

                    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                    const clonedMaterials = materials.map((material: THREE.Material) => {
                        const cloned = material.clone() as THREE.MeshStandardMaterial & {
                            color: THREE.Color;
                            emissive: THREE.Color;
                            emissiveIntensity: number;
                        };
                        cloned.color = cloned.color ?? new THREE.Color(0xffffff);
                        cloned.emissive = cloned.emissive ?? new THREE.Color(0x000000);
                        cloned.emissiveIntensity = cloned.emissiveIntensity ?? 0;
                        shaded.push({
                            material: cloned,
                            baseColor: cloned.color.clone(),
                            baseEmissive: cloned.emissive.clone(),
                            baseEmissiveIntensity: cloned.emissiveIntensity,
                            baseRoughness: cloned.roughness,
                            baseMetalness: cloned.metalness,
                            group,
                            corner: group === "tyre" ? corner : null,
                        });
                        counts[group] = (counts[group] ?? 0) + 1;
                        return cloned;
                    });
                    mesh.material = Array.isArray(mesh.material) ? clonedMaterials : clonedMaterials[0];
                });

                shadedRef.current = shaded;
                setMatchedCounts(counts);
                modelRoot.add(model);
                setMode("live");
            },
            undefined,
            () => {
                clearModel();
                setMode("fallback");
            },
        );

        const tick = () => {
            const now = performance.now();
            if (now - idleSinceRef.current > 1200 && !dragRef.current.active) {
                orbitRef.current.yaw += 0.003;
            }
            updateCamera();
            renderer.render(scene, camera);
            frameRef.current = window.requestAnimationFrame(tick);
        };
        frameRef.current = window.requestAnimationFrame(tick);

        return () => {
            ro.disconnect();
            host.removeEventListener("pointerdown", onPointerDown);
            host.removeEventListener("pointermove", onPointerMove);
            host.removeEventListener("pointerup", onPointerUp);
            host.removeEventListener("pointerleave", onPointerUp);
            host.removeEventListener("wheel", onWheel);
            if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
            clearModel();
            renderer.dispose();
            rendererRef.current = null;
            sceneRef.current = null;
            cameraRef.current = null;
            setMatchedCounts({});
            setMode(enabled ? "loading" : "fallback");
        };
    }, [enabled]);

    useEffect(() => {
        if (!enabled || mode !== "live") return;
        if (!shadedRef.current.length) return;

        const hottestTyre = heat.hottestTyre;
        for (const shaded of shadedRef.current) {
            const { material, group, corner } = shaded;
            let value: number | null = null;
            if (group === "tyre") {
                const cornerTemp = corner ? tyreTemps?.[corner] : undefined;
                const source = typeof cornerTemp === "number" ? cornerTemp : hottestTyre;
                value = source === null ? null : clamp01((source - 85) / (125 - 85));
            } else if (group === "brake") {
                value = heat.brake;
            } else {
                value = heat.engine;
            }

            const quantised = quantiseHeat(value);
            if (quantised === null) continue;
            const key = `${group}:${material.uuid}:${corner ?? ""}`;
            if (lastAppliedRef.current.get(key) === quantised) continue;
            lastAppliedRef.current.set(key, quantised);

            if (group === "tyre" && quantised < 0.12) {
                material.color.copy(shaded.baseColor);
                material.emissive.copy(shaded.baseEmissive);
                material.emissiveIntensity = shaded.baseEmissiveIntensity;
                if (shaded.baseRoughness !== undefined) material.roughness = shaded.baseRoughness;
                if (shaded.baseMetalness !== undefined) material.metalness = shaded.baseMetalness;
                material.needsUpdate = true;
                continue;
            }

            const color = heatColor(quantised);
            material.color.copy(color);
            material.emissive.copy(color);
            material.emissiveIntensity = group === "tyre" ? 0.9 * quantised + 0.15 : group === "brake" ? 1.4 * quantised + 0.2 : 1.0 * quantised + 0.12;
            material.needsUpdate = true;
        }
    }, [enabled, mode, tyreTemps, heat]);

    const tyreReadout = (corner: Corner) => {
        const value = tyreTemps?.[corner];
        const t = typeof value === "number" ? clamp01((value - 85) / (125 - 85)) : null;
        return (
            <span key={corner} className={`heat-chip tyre-${corner.toLowerCase()}`}>
                <i style={{ background: t === null ? "#4b5861" : heatCss(t) }} />
                {corner} <b>{typeof value === "number" ? `${Math.round(value)}°` : "—"}</b>
            </span>
        );
    };

    const readout = (label: string, value: number | null | undefined, t: number | null, unit = "°") => (
        <span className="heat-chip" key={label}>
            <i style={{ background: t === null ? "#4b5861" : heatCss(t), color: t === null ? "#4b5861" : heatCss(t) }} />
            {label} <b>{typeof value === "number" ? `${Math.round(value)}${unit}` : "—"}</b>
        </span>
    );

    return (
        <>
            {enabled && mode !== "fallback" ? (
                <div ref={hostRef} className="car-viewer-shell" aria-label="Interactive 3D car model">
                    <canvas ref={canvasRef} className="car-viewer" />
                </div>
            ) : (
                <img className="formula-car" src="/formula-car.png" alt="Unbranded graphite Formula-style racing car viewed from above" />
            )}

            {telemetry && (
                <>
                    <div className="tyre-readouts" aria-label="Tyre temperatures">
                        {CORNER_KEYS.map(tyreReadout)}
                    </div>
                    <div className="heat-readouts">
                        {readout("BRAKE", brakeTemp, heat.brake)}
                        {readout("ENGINE", engineTemp, heat.engine)}
                    </div>
                </>
            )}

            {mode === "loading" && <span className="car-viewer-status">LOADING LOCAL 3D MODEL…</span>}
            {mode === "live" && Object.keys(matchedCounts).length === 0 && (
                <span className="car-viewer-status subtle">MODEL LOADED · NO SHADEABLE PARTS MATCHED</span>
            )}
        </>
    );
}
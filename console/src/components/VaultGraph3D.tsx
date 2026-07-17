"use client";

import { useEffect, useRef, useState } from "react";
import type * as ThreeNS from "three";
import { cssToken } from "@/components/kit";

// ─────────────────────────────────────────────────────────────────────────────
// THE VAULT AS ONE GALAXY (operator rulings 2026-07-12, revised same day:
// "a full three-dimensional unified object that moves like a galaxy — navigate
// it like a spaceship. The organization follows the actual file structure").
//   · every folder is a star; the files inside it swarm around it as a BALL
//   · sub-folders sit on a SPHERE around their parent star — structure IS
//     layout, now in all three axes instead of flat rings
//   · agents = large faceted gems + halo + always-on name; Valence at center
//   · gold moving sparks = one note referencing another (information flow)
// No physics: the layout is computed once from the real tree, so the map is a
// rigid object. Slow orbital drift is the only self-motion (off under
// prefers-reduced-motion).
// Navigation = the Apple-Maps globe (operator ruling, same day, walking back
// a free-flight camera as overkill): swiping turns the WHOLE object, pinching
// or scrolling zooms, two-finger drag slides. Nothing more. Clicking any
// folder or file glides the camera to it AND hands it to the navigator below
// the graph.
// Data: /api/graph?mode=vault (ownership facts from vault/os/ownership.md).
// Pure three.js — loaded lazily, client-only.
// ─────────────────────────────────────────────────────────────────────────────

export interface VaultNode {
  id: string; label: string; kind: "agent" | "key" | "dir" | "file";
  tier: number;
  color: string; central?: boolean; count?: number; bytes?: number;
  owner?: string; root?: string; dir?: string; path?: string; tip: string;
}
interface VaultLink { source: string; target: string; kind: "command" | "key" | "branch" | "ref" | "orphan" }
interface VaultGraphData {
  stats: { agents: number; keyFiles: number; folders: number; files: number; refs: number; unownedFiles: number; unownedAreas: string[] };
  nodes: VaultNode[];
  links: VaultLink[];
}

// deterministic 0..1 per id — stable layout across reloads (no randomness)
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}
const log2 = (n: number) => Math.log2(Math.max(1, n));

// visual radius of the star itself (same sizing family as the previous map)
function visR(n: VaultNode): number {
  if (n.kind === "agent") return n.central ? 11 : 8;
  if (n.kind === "key") return 1.9;
  if (n.kind === "dir") return 2.2 + Math.min(4.2, log2((n.count ?? 0) + 2) * 0.85);
  return 0.9 + Math.min(1.6, log2((n.bytes ?? 0) / 1024 + 2) * 0.22);
}

interface Placed {
  node: VaultNode;
  local: [number, number, number]; // position inside the parent's orbit frame
  clusterR: number;                // radius of this star + everything around it
  children: Placed[];
  depth: number;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

// recursive volumetric layout: files fill a ball around their folder (golden-
// spiral directions, hashed depth into the ball); sub-folders take a sphere
// shell outside the ball, its radius grown until every child cluster gets a
// patch of sky big enough for itself — tight and collision-free by area.
function layout(node: VaultNode, childrenOf: Map<string, VaultNode[]>, depth: number): Placed {
  const kids = childrenOf.get(node.id) ?? [];
  const ballKids = kids.filter((k) => k.kind === "file" || k.kind === "key");
  const shellKids = kids.filter((k) => k.kind === "dir" || k.kind === "agent")
    .map((k) => layout(k, childrenOf, depth + 1))
    .sort((a, b) => b.clusterR - a.clusterR);

  const own = visR(node);
  const coreR = own * 1.7 + 0.9;
  const phase = hash01(node.id) * Math.PI * 2;

  // ── the file ball: golden-spiral sphere directions, hashed radial depth ──
  let ballR = 0;
  const placedBall: Placed[] = [];
  if (ballKids.length) {
    const n = ballKids.length;
    const avg = ballKids.reduce((s, k) => s + visR(k), 0) / n;
    const spacing = Math.max(1.35, avg * 1.9);
    const thick = spacing * (0.62 * Math.cbrt(n) + 0.5);
    let maxV = 0;
    ballKids.forEach((k, i) => {
      const y = 1 - (2 * (i + 0.5)) / n;          // sweep the whole sphere
      const s = Math.sqrt(Math.max(0, 1 - y * y));
      const a = phase + i * GOLDEN;
      const r = coreR + thick * Math.cbrt(0.08 + 0.92 * hash01(k.id)); // even fill of the volume
      maxV = Math.max(maxV, visR(k));
      placedBall.push({
        node: k, local: [r * s * Math.cos(a), r * y, r * s * Math.sin(a)],
        clusterR: visR(k), children: [], depth: depth + 1,
      });
    });
    ballR = coreR + thick + maxV;
  }

  // ── the sub-folder sphere: radius from summed patch area, placement order
  //    hashed so big clusters spread out instead of crowding one pole.
  //    Children are packed by their dense CORE, not their full bounding
  //    sphere — clusters are nearly empty at the rim, so letting the bounds
  //    interleave is what makes the map read as one body, not scattered
  //    tufts on long threads (operator ruling after seeing it live). ──
  const GAP = 2;
  const eff = (c: number) => c * 0.55;
  let shellR = 0;
  if (shellKids.length) {
    const m = shellKids.length;
    const maxChild = shellKids[0].clusterR;
    const patchArea = shellKids.reduce((s, k) => s + (eff(k.clusterR) + GAP / 2) ** 2, 0);
    shellR = Math.max(
      Math.max(ballR, coreR) * 0.9 + eff(maxChild) + GAP,
      Math.sqrt(patchArea / 2.6),
    );
    // the agent ring gets extra air: territories stay tight inside, but the
    // agents themselves keep clear water between them (operator ruling)
    if (depth === 0) shellR *= 1.45;
    const order = [...shellKids].sort((a, b) => hash01(a.node.id) - hash01(b.node.id));
    order.forEach((k, i) => {
      const y = m === 1 ? 0 : 1 - (2 * (i + 0.5)) / m;
      const s = Math.sqrt(Math.max(0, 1 - y * y));
      const a = phase + i * GOLDEN;
      const r = shellR * (0.94 + 0.12 * hash01(k.node.id)); // slight depth so the shell reads organic
      k.local = [r * s * Math.cos(a), r * y, r * s * Math.sin(a)];
    });
  }

  const clusterR = Math.max(
    own + 2,
    shellKids.length ? shellR + eff(shellKids[0].clusterR) + GAP : 0,
    ballR + 1,
  );
  return { node, local: [0, 0, 0], clusterR, children: [...shellKids, ...placedBall], depth };
}

export function VaultGraph3D({ onOpenFile }: { onOpenFile?: (root: string, relPath: string, isDir?: boolean) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<VaultGraphData | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const openRef = useRef(onOpenFile);
  const fitRef = useRef<() => void>(() => {});
  useEffect(() => { openRef.current = onOpenFile; }, [onOpenFile]);

  useEffect(() => {
    fetch("/api/graph?mode=vault")
      .then((r) => r.json())
      .then((d) => (d.nodes ? setData(d) : setFailed(true)))
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !data) return;
    let disposed = false;
    let raf = 0;
    let ro: ResizeObserver | null = null;
    let renderer: ThreeNS.WebGLRenderer | null = null;
    const listeners: [EventTarget, string, EventListenerOrEventListenerObject, AddEventListenerOptions?][] = [];

    (async () => {
      const THREE = await import("three");
      if (disposed) return;

      const goldHex = cssToken("--accent", "#c9a45a");
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      // ── rebuild the real tree from the structural links ──
      const byId = new Map(data.nodes.map((n) => [n.id, n]));
      const childrenOf = new Map<string, VaultNode[]>();
      const refs: [string, string][] = [];
      for (const l of data.links) {
        if (l.kind === "ref") { refs.push([l.source, l.target]); continue; }
        const arr = childrenOf.get(l.source) ?? [];
        const child = byId.get(l.target);
        if (child) { arr.push(child); childrenOf.set(l.source, arr); }
      }
      const rootNode = data.nodes.find((n) => n.central) ?? data.nodes[0];
      if (!rootNode) { setFailed(true); return; }
      const tree = layout(rootNode, childrenOf, 0);

      // ── scene ──
      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xcfd6e4, 1.6));
      const sun = new THREE.DirectionalLight(0xffffff, 1.1);
      sun.position.set(1, 2, 1.4);
      scene.add(sun);

      const fileGeo = new THREE.SphereGeometry(1, 10, 8);
      const dirGeo = new THREE.OctahedronGeometry(1, 0);
      const agentGeo = new THREE.IcosahedronGeometry(1, 0);
      const haloGeo = new THREE.TorusGeometry(1, 0.035, 8, 48);

      const matCache = new Map<string, { file: ThreeNS.Material; dir: ThreeNS.Material; agent: ThreeNS.Material; line: ThreeNS.LineBasicMaterial }>();
      const matsFor = (hex: string) => {
        let m = matCache.get(hex);
        if (!m) {
          m = {
            file: new THREE.MeshPhysicalMaterial({
              color: hex, emissive: hex, emissiveIntensity: 0.42,
              metalness: 0.05, roughness: 0.6, clearcoat: 0.2, clearcoatRoughness: 0.5,
            }),
            dir: new THREE.MeshPhysicalMaterial({
              color: hex, emissive: hex, emissiveIntensity: 0.5,
              metalness: 0.15, roughness: 0.4, clearcoat: 0.5, clearcoatRoughness: 0.3,
            }),
            agent: new THREE.MeshPhysicalMaterial({
              color: hex, emissive: hex, emissiveIntensity: 0.7,
              metalness: 0.3, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.15,
            }),
            line: new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 0.32 }),
          };
          matCache.set(hex, m);
        }
        return m;
      };

      const nameSprite = (text: string, hex: string, shrink: number) => {
        const c = document.createElement("canvas");
        const ctx = c.getContext("2d")!;
        const font = "600 30px ui-sans-serif, system-ui";
        ctx.font = font;
        const w = Math.ceil(ctx.measureText(text).width) + 26;
        c.width = w; c.height = 48;
        ctx.font = font;
        ctx.textBaseline = "middle";
        ctx.shadowColor = hex; ctx.shadowBlur = 12;
        ctx.fillStyle = "#f4f6fa";
        ctx.fillText(text, 13, 25);
        ctx.shadowBlur = 0;
        ctx.fillText(text, 13, 25);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
        sprite.scale.set(w / shrink, 48 / shrink, 1);
        return sprite;
      };

      // ── build the rigid object: nested groups, each with a slow-spinning
      //    orbit frame — the only self-motion in the map ──
      const pickables: ThreeNS.Mesh[] = [];
      const meshOf = new Map<string, ThreeNS.Mesh>();
      const clusterOf = new Map<string, Placed>();
      const spinners: { frame: ThreeNS.Group; speed: number }[] = [];
      const V = new THREE.Vector3();

      function build(p: Placed): ThreeNS.Group {
        const n = p.node;
        const mats = matsFor(n.color);
        const g = new THREE.Group();
        g.position.set(p.local[0], p.local[1], p.local[2]);

        const r = visR(n);
        let mesh: ThreeNS.Mesh;
        if (n.kind === "agent") {
          mesh = new THREE.Mesh(agentGeo, mats.agent);
          mesh.scale.setScalar(r);
          const halo = new THREE.Mesh(haloGeo, mats.agent);
          halo.scale.setScalar(r * 1.8);
          halo.rotation.x = Math.PI / 2.6;
          g.add(halo);
          const label = nameSprite(n.label, n.color, 2.6);
          label.position.y = r * 2.6;
          g.add(label);
        } else if (n.kind === "key") {
          mesh = new THREE.Mesh(agentGeo, mats.agent);
          mesh.scale.setScalar(r);
        } else if (n.kind === "dir") {
          mesh = new THREE.Mesh(dirGeo, mats.dir);
          mesh.scale.setScalar(r);
          if (p.depth <= 2) { // named areas straight under an agent stay labeled
            const label = nameSprite(n.label, n.color, 4.2);
            label.position.y = r * 2.2 + 3;
            g.add(label);
          }
        } else {
          mesh = new THREE.Mesh(fileGeo, mats.file);
          mesh.scale.setScalar(r);
        }
        mesh.userData.nodeId = n.id;
        g.add(mesh);
        pickables.push(mesh);
        meshOf.set(n.id, mesh);
        clusterOf.set(n.id, p);

        if (p.children.length) {
          // the orbit frame — tilted a little per star, spinning very slowly
          const frame = new THREE.Group();
          const tiltScale = Math.min(0.9, 0.18 + p.depth * 0.16);
          frame.rotation.x = (hash01(n.id + "x") - 0.5) * tiltScale;
          frame.rotation.z = (hash01(n.id + "z") - 0.5) * tiltScale;
          frame.rotation.y = hash01(n.id + "y") * Math.PI * 2;
          if (!reduceMotion) {
            const dir = hash01(n.id + "s") > 0.5 ? 1 : -1;
            spinners.push({ frame, speed: dir * 0.045 / Math.sqrt(1 + p.clusterR / 14) });
          }
          for (const child of p.children) {
            frame.add(build(child));
            if (child.node.kind === "dir" || child.node.kind === "agent") {
              // constellation spoke: parent star → child star, rides the frame
              const geo = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(0, 0, 0),
                new THREE.Vector3(child.local[0], child.local[1], child.local[2]),
              ]);
              frame.add(new THREE.Line(geo, matsFor(child.node.color).line));
            }
          }
          g.add(frame);
        }
        return g;
      }
      const root = build(tree);
      scene.add(root);

      // ── gold reference sparks: note → note, endpoints follow the orbits ──
      const liveRefs = refs.filter(([a, b]) => meshOf.has(a) && meshOf.has(b));
      let refLines: ThreeNS.LineSegments | null = null;
      let sparkPts: ThreeNS.Points | null = null;
      if (liveRefs.length) {
        const linePos = new Float32Array(liveRefs.length * 6);
        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
        refLines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
          color: goldHex, transparent: true, opacity: 0.22,
        }));
        refLines.frustumCulled = false;
        scene.add(refLines);
        const sparkPos = new Float32Array(liveRefs.length * 3);
        const sparkGeo = new THREE.BufferGeometry();
        sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
        sparkPts = new THREE.Points(sparkGeo, new THREE.PointsMaterial({
          color: goldHex, size: 2.6, transparent: true, opacity: 0.9,
          sizeAttenuation: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        sparkPts.frustumCulled = false;
        scene.add(sparkPts);
      }
      const worldOf = (id: string, out: ThreeNS.Vector3) => {
        const e = meshOf.get(id)!.matrixWorld.elements;
        out.set(e[12], e[13], e[14]);
      };

      // ── camera + Apple-Maps-style controls: swipe spins the whole object,
      //    pinch zooms, two-finger drag slides. Inertia on everything. ──
      const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 10);
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
      wrap.appendChild(renderer.domElement);
      renderer.domElement.style.touchAction = "none";

      const fitDist = (radius: number) => (radius * 1.0) / Math.tan((camera.fov * Math.PI) / 360);
      const overviewD = fitDist(tree.clusterR);
      camera.far = overviewD * 6;
      camera.updateProjectionMatrix();
      // mild haze only — every visible dot on this map IS a real file or folder
      scene.fog = new THREE.FogExp2(0x0b101a, 0.12 / overviewD);

      const cam = {
        theta: 0.7, phi: 1.05, dist: overviewD,
        target: new THREE.Vector3(0, 0, 0),
        vTheta: 0, vPhi: 0,
      };
      const minDist = 8, maxDist = overviewD * 2.2;
      const clampCam = () => {
        cam.phi = Math.min(Math.PI - 0.15, Math.max(0.15, cam.phi));
        cam.dist = Math.min(maxDist, Math.max(minDist, cam.dist));
      };
      const applyCam = () => {
        camera.position.set(
          cam.target.x + cam.dist * Math.sin(cam.phi) * Math.cos(cam.theta),
          cam.target.y + cam.dist * Math.cos(cam.phi),
          cam.target.z + cam.dist * Math.sin(cam.phi) * Math.sin(cam.theta),
        );
        camera.lookAt(cam.target);
      };

      // camera glide (click-to-focus, "see everything")
      interface CamPose { theta: number; phi: number; dist: number; target: ThreeNS.Vector3 }
      let glide: { t: number; dur: number; from: CamPose; to: CamPose } | null = null;
      const startGlide = (to: CamPose) => {
        glide = { t: 0, dur: 0.9, from: { theta: cam.theta, phi: cam.phi, dist: cam.dist, target: cam.target.clone() }, to };
        cam.vTheta = 0; cam.vPhi = 0;
      };
      const glideTo = (id: string) => {
        const p = clusterOf.get(id);
        const m = meshOf.get(id);
        if (!p || !m) return;
        const t = new THREE.Vector3();
        worldOf(id, t);
        startGlide({ theta: cam.theta, phi: cam.phi, dist: Math.max(minDist, fitDist(Math.max(p.clusterR, visR(p.node) * 6))), target: t });
      };
      fitRef.current = () => startGlide({ theta: 0.7, phi: 1.05, dist: overviewD, target: new THREE.Vector3(0, 0, 0) });

      const cancelGlide = () => { glide = null; };

      // pointers (mouse drag / touch swipe / pinch / two-finger slide)
      const pointers = new Map<number, { x: number; y: number }>();
      let pinchDist = 0;
      let downAt: { x: number; y: number } | null = null;
      const el = renderer.domElement;
      const rotK = 0.005;
      const on = (t: EventTarget, e: string, f: EventListenerOrEventListenerObject, o?: AddEventListenerOptions) => {
        t.addEventListener(e, f, o); listeners.push([t, e, f, o]);
      };

      const panBy = (dx: number, dy: number) => {
        const k = (cam.dist * 0.0016);
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
        cam.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
      };

      on(el, "pointerdown", ((e: PointerEvent) => {
        el.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) downAt = { x: e.clientX, y: e.clientY };
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        }
        cancelGlide();
        cam.vTheta = 0; cam.vPhi = 0;
      }) as EventListener);

      on(el, "pointermove", ((e: PointerEvent) => {
        pick(e);
        const p = pointers.get(e.pointerId);
        if (!p) return;
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) {
          if (e.buttons === 2) {
            panBy(dx, dy); // right-drag slides the map sideways
          } else {
            cam.theta += dx * rotK; cam.phi -= dy * rotK;
            cam.vTheta = dx * rotK; cam.vPhi = -dy * rotK;
            clampCam();
          }
        } else if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinchDist > 0) { cam.dist *= pinchDist / d; clampCam(); }
          pinchDist = d;
          panBy(dx / 2, dy / 2); // two-finger drag slides
        }
      }) as EventListener);

      const endPointer = ((e: PointerEvent) => {
        pointers.delete(e.pointerId);
        pinchDist = 0;
      }) as EventListener;
      on(el, "pointerup", endPointer);
      on(el, "pointercancel", endPointer);
      on(el, "contextmenu", ((e: Event) => e.preventDefault()) as EventListener);

      // trackpad: two-finger swipe spins the map (like the Maps globe),
      // pinch (ctrl+wheel) zooms; mouse wheel zooms too
      on(el, "wheel", ((e: WheelEvent) => {
        e.preventDefault();
        cancelGlide();
        // trackpad pinch reports ctrlKey; a sideways component means a swipe;
        // a plain mouse wheel (vertical, coarse steps) means zoom
        const isSwipe = Math.abs(e.deltaX) > 0.5 ||
          (e.deltaMode === 0 && Math.abs(e.deltaY) < 40 && e.deltaY % 1 !== 0);
        if (e.ctrlKey || e.metaKey) {
          cam.dist *= Math.exp(e.deltaY * 0.009);
        } else if (isSwipe) {
          cam.theta += e.deltaX * 0.0022;
          cam.phi -= e.deltaY * 0.0022;
          cam.vTheta = e.deltaX * 0.0012; cam.vPhi = -e.deltaY * 0.0012;
        } else {
          cam.dist *= Math.exp(e.deltaY * 0.0028);
        }
        clampCam();
      }) as EventListener, { passive: false });

      // hover tooltip + click-through
      const ray = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      let hovered: VaultNode | null = null;
      const pick = (e: PointerEvent | MouseEvent) => {
        const rect = el.getBoundingClientRect();
        ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        ray.setFromCamera(ndc, camera);
        const hit = ray.intersectObjects(pickables, false)[0];
        const n = hit ? byId.get((hit.object as ThreeNS.Mesh).userData.nodeId as string) ?? null : null;
        hovered = n;
        el.style.cursor = n && (n.root || n.kind === "dir" || n.kind === "file") ? "pointer" : "grab";
        const tip = tipRef.current;
        if (tip) {
          if (n) {
            tip.textContent = n.tip;
            tip.style.opacity = "1";
            tip.style.left = `${e.clientX - rect.left + 14}px`;
            tip.style.top = `${e.clientY - rect.top + 14}px`;
          } else tip.style.opacity = "0";
        }
      };

      on(el, "click", ((e: MouseEvent) => {
        if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) return; // it was a swipe
        pick(e);
        const n = hovered;
        if (!n) return;
        glideTo(n.id);
        if (n.kind === "dir" && n.root !== undefined) openRef.current?.(n.root, n.dir ?? "", true);
        else if (n.kind === "file" && n.root && n.path) openRef.current?.(n.root, n.path, false);
      }) as EventListener);

      // ── frame loop: orbit drift, inertia, glide, spark travel ──
      const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      let last = performance.now();
      const tick = () => {
        if (disposed) return;
        raf = requestAnimationFrame(tick);
        const now = performance.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;

        for (const s of spinners) s.frame.rotation.y += s.speed * dt;

        if (pointers.size === 0) {
          cam.theta += cam.vTheta; cam.phi += cam.vPhi;
          cam.vTheta *= 0.92; cam.vPhi *= 0.92;
          clampCam();
        }
        if (glide) {
          glide.t += dt / glide.dur;
          const k = easeInOut(Math.min(1, glide.t));
          cam.theta = glide.from.theta + (glide.to.theta - glide.from.theta) * k;
          cam.phi = glide.from.phi + (glide.to.phi - glide.from.phi) * k;
          cam.dist = glide.from.dist + (glide.to.dist - glide.from.dist) * k;
          cam.target.lerpVectors(glide.from.target, glide.to.target, k);
          if (glide.t >= 1) glide = null;
        }
        applyCam();

        if (refLines && sparkPts) {
          const lp = refLines.geometry.getAttribute("position") as ThreeNS.BufferAttribute;
          const sp = sparkPts.geometry.getAttribute("position") as ThreeNS.BufferAttribute;
          const A = new THREE.Vector3();
          for (let i = 0; i < liveRefs.length; i++) {
            worldOf(liveRefs[i][0], A);
            lp.setXYZ(i * 2, A.x, A.y, A.z);
            worldOf(liveRefs[i][1], V);
            lp.setXYZ(i * 2 + 1, V.x, V.y, V.z);
            const t = (now / 1000 * 0.12 + hash01(liveRefs[i][0] + liveRefs[i][1])) % 1;
            sp.setXYZ(i, A.x + (V.x - A.x) * t, A.y + (V.y - A.y) * t, A.z + (V.z - A.z) * t);
          }
          lp.needsUpdate = true;
          sp.needsUpdate = true;
        }

        renderer!.render(scene, camera);
      };

      const resize = () => {
        if (!wrap.clientWidth || !renderer) return;
        renderer.setSize(wrap.clientWidth, wrap.clientHeight);
        camera.aspect = wrap.clientWidth / wrap.clientHeight;
        camera.updateProjectionMatrix();
      };
      resize();
      applyCam();
      ro = new ResizeObserver(resize);
      ro.observe(wrap);
      tick();
      setReady(true);
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      for (const [t, e, f, o] of listeners) t.removeEventListener(e, f, o);
      renderer?.dispose();
      if (wrap) wrap.innerHTML = "";
    };
  }, [data]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex flex-wrap items-center gap-3 text-caption text-ink-dim">
          <span className="flex items-center gap-1.5">THE MAP IS THE FILE TREE — EVERY FOLDER IS A STAR, ITS FILES SWARM AROUND IT, ITS SUB-FOLDERS ORBIT IT</span>
          <span className="flex items-center gap-1.5"><span aria-hidden className="text-ink-dim">◆</span> BIGGER STAR = MORE FILES INSIDE</span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-px w-4" style={{ background: "repeating-linear-gradient(90deg, var(--accent) 0 3px, transparent 3px 6px)" }} /> GOLD SPARKS = ONE NOTE POINTS AT ANOTHER
          </span>
        </div>
        {data && (
          <span className="text-micro text-ink-dim">
            {data.stats.agents} agents · {data.stats.keyFiles} key files · {data.stats.folders.toLocaleString("en-US")} folders · {data.stats.files.toLocaleString("en-US")} files · {data.stats.refs.toLocaleString("en-US")} cross-references
            {data.stats.unownedFiles > 0 && (
              <span
                className="ml-2 text-tone-warn-ink"
                title={`Nobody owns these yet — assign them in the ownership manifest: ${data.stats.unownedAreas.join(", ")}`}
              >
                ⚠ {data.stats.unownedFiles.toLocaleString("en-US")} files nobody owns
              </span>
            )}
          </span>
        )}
      </div>
      <div className="glass-strong relative flex-1 overflow-hidden rounded-pane">
        {/* the deep field — same dark room in day and night, so the colored
            solids read as lit objects */}
        <div
          ref={wrapRef}
          className="absolute inset-0"
          style={{ background: "radial-gradient(120% 90% at 50% 38%, #131a26 0%, #0b101a 62%, #070b12 100%)" }}
        />
        <div
          ref={tipRef}
          className="pointer-events-none absolute z-10 max-w-[340px] rounded-md px-2 py-1 text-[12px]"
          style={{ background: "rgba(10,14,18,0.88)", color: "#e8e6df", opacity: 0, transition: "opacity 120ms" }}
        />
        {ready && (
          <button
            type="button"
            onClick={() => fitRef.current()}
            className="absolute right-3 top-3 z-10 rounded-md px-2.5 py-1 text-micro"
            style={{ background: "rgba(10,14,18,0.7)", color: "#dfe5ec", border: "1px solid rgba(223,229,236,0.18)" }}
          >
            See everything
          </button>
        )}
        {!ready && !failed && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-caption" style={{ color: "#9aa4b5" }}>
            {data ? "shaping the vault…" : "reading the vault…"}
          </div>
        )}
        {failed && <div className="flex h-full items-center justify-center text-caption text-ink-dim">The ownership manifest isn&apos;t readable right now.</div>}
        {ready && (
          <p className="pointer-events-none absolute bottom-2 left-3 text-micro" style={{ color: "#8b95a7" }}>
            swipe or drag to turn the whole map · pinch or scroll to zoom · two-finger drag to slide · click a star to fly to it and open it below
          </p>
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";

import { useAsciiBackground } from "@/lib/ascii-background-preference";
import {
  asciiLevel,
  botTint,
  botTintHex,
  createAsciiRenderer,
  luminance,
  sameLevel,
  stepLevel,
  type AsciiLevel,
  type AsciiMode,
  type AsciiPalette,
  type Rgb,
} from "@/lib/ascii-field";
import type { MausColor } from "@/lib/mascot";

const FOCUSED_FRAME_MS = 1000 / 30;
const UNFOCUSED_FRAME_MS = 1000 / 10;
const FADE_MS = 700;
const REDUCED_MOTION_TIME = 30;
const SESSION_CLOCK_OFFSET = 200 + Math.random() * 600;
const MONO_FALLBACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function reducedMotion(): boolean {
  if (document.documentElement.dataset.reducedMotion === "true") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

let probe: CanvasRenderingContext2D | null | undefined;

function resolveColor(value: string): Rgb | null {
  if (probe === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    probe = canvas.getContext("2d", { willReadFrequently: true });
  }
  const css = value.trim();
  if (!probe || !css) return null;
  const sentinel = "rgba(1, 2, 3, 0.5)";
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = sentinel;
  probe.fillStyle = css;
  if (probe.fillStyle === sentinel) return null;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  if (!a) return null;
  return [r / 255, g / 255, b / 255];
}

function readPalette(el: Element, colors: readonly MausColor[]): AsciiPalette {
  const style = getComputedStyle(el);
  const base = resolveColor(style.getPropertyValue("--color-ink-tertiary")) ?? [0.55, 0.55, 0.55];
  const accent = resolveColor(style.getPropertyValue("--color-accent")) ?? base;
  const app = resolveColor(style.getPropertyValue("--color-app"));
  const lightSkin = app ? luminance(app) > 0.4 : false;
  const tint = botTint(colors) ?? { light: accent, deep: accent };
  return {
    ...tint,
    base,
    glow: lightSkin ? [0, 0, 0] : [1, 1, 1],
    glowMix: lightSkin ? 0.2 : 0.3,
    peak: lightSkin ? 0.32 : 0.3,
  };
}

function monoFont(el: Element): string {
  return getComputedStyle(el).getPropertyValue("--font-mono").trim() || MONO_FALLBACK;
}

type AsciiFieldProps = { mode: AsciiMode; colors?: readonly MausColor[] };

const NO_COLORS: readonly MausColor[] = [];

export function AsciiField({ mode, colors = NO_COLORS }: AsciiFieldProps) {
  const enabled = useAsciiBackground();
  if (!enabled) return null;
  return <AsciiCanvas mode={mode} colors={colors} />;
}

function AsciiCanvas({ mode, colors }: Required<AsciiFieldProps>) {
  const ref = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef(mode);
  const colorsRef = useRef(colors);
  const kickRef = useRef<() => void>(() => {});
  const restyleRef = useRef<() => void>(() => {});
  const [generation, setGeneration] = useState(0);
  const colorKey = colors.join(" ");

  useEffect(() => {
    modeRef.current = mode;
    kickRef.current();
  }, [mode]);

  useEffect(() => {
    colorsRef.current = colorKey ? (colorKey.split(" ") as MausColor[]) : NO_COLORS;
    restyleRef.current();
  }, [colorKey]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const renderer = createAsciiRenderer(canvas);
    if (!renderer) return;

    let palette = readPalette(canvas, colorsRef.current);
    let font = monoFont(canvas);
    let still = reducedMotion();
    let dpr = window.devicePixelRatio || 1;
    let shown: AsciiLevel = { brightness: 0, clearCenter: asciiLevel(modeRef.current).clearCenter };
    let raf = 0;
    let last = 0;

    const size = () => {
      const box = canvas.getBoundingClientRect();
      renderer.resize(box.width, box.height, dpr, font);
    };

    const frame = (now: number) => {
      raf = 0;
      if (last && now - last < (document.hasFocus() ? FOCUSED_FRAME_MS : UNFOCUSED_FRAME_MS) - 1) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = last ? Math.min(now - last, 100) : 0;
      last = now;
      if ((window.devicePixelRatio || 1) !== dpr) {
        dpr = window.devicePixelRatio || 1;
        size();
      }
      const target = asciiLevel(modeRef.current);
      shown = still ? target : stepLevel(shown, target, dt, FADE_MS);
      renderer.draw(still ? REDUCED_MOTION_TIME : now / 1000 + SESSION_CLOCK_OFFSET, shown, palette);
      if (still && sameLevel(shown, target)) {
        last = 0;
        return;
      }
      raf = requestAnimationFrame(frame);
    };

    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    kickRef.current = kick;

    const restyle = () => {
      palette = readPalette(canvas, colorsRef.current);
      font = monoFont(canvas);
      still = reducedMotion();
      size();
      kick();
    };

    restyleRef.current = restyle;
    size();
    kick();

    const resize = new ResizeObserver(() => {
      size();
      kick();
    });
    resize.observe(canvas);
    const root = new MutationObserver(restyle);
    root.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin", "data-reduced-motion", "data-font", "class"] });
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    motion.addEventListener("change", restyle);
    const lost = (event: Event) => {
      event.preventDefault();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const restored = () => setGeneration((n) => n + 1);
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      kickRef.current = () => {};
      restyleRef.current = () => {};
      resize.disconnect();
      root.disconnect();
      motion.removeEventListener("change", restyle);
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      renderer.dispose();
    };
  }, [generation]);

  const tint = botTintHex(colors);
  const light = tint?.light ?? "var(--color-accent)";
  const deep = tint?.deep ?? "var(--color-accent)";
  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 transition-opacity duration-700"
        style={{
          opacity: asciiLevel(mode).brightness,
          backgroundImage: [
            `radial-gradient(ellipse 75% 65% at 90% 5%, color-mix(in srgb, ${light} 16%, transparent), transparent 70%)`,
            `radial-gradient(ellipse 75% 65% at 5% 100%, color-mix(in srgb, ${deep} 18%, transparent), transparent 70%)`,
          ].join(", "),
        }}
      />
      <canvas
        ref={ref}
        aria-hidden="true"
        data-ascii-field=""
        className="pointer-events-none absolute inset-0 h-full w-full select-none"
      />
    </>
  );
}

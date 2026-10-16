import { useEffect, useRef, useState } from "react";

import { useAsciiBackground } from "@/lib/ascii-background-preference";
import { createAsciiRenderer, luminance, stepFade, type AsciiPalette, type Rgb } from "@/lib/ascii-field";

const FRAME_MS = 1000 / 30;
/** Behind other windows the field keeps drifting, more slowly, to spare the GPU. */
const UNFOCUSED_FRAME_MS = 1000 / 10;
const FADE_MS = 700;
/** The moment a still (reduced-motion) field shows: a calm one, mid-swell. */
const STILL_TIME = 30;
/** Shared by every mount, so switching chats does not restart the drift. */
const CLOCK_OFFSET = 200 + Math.random() * 600;
const MONO_FALLBACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
/** Keeps the empty chat's avatar, name and prompt (centred in the pane) on a clean ground. */
const CLEAR_CENTER = {
  maskImage: "radial-gradient(ellipse 300px 150px at 50% 47%, transparent 40%, black 100%)",
  WebkitMaskImage: "radial-gradient(ellipse 300px 150px at 50% 47%, transparent 40%, black 100%)",
} as const;

function reducedMotion(): boolean {
  if (document.documentElement.dataset.reducedMotion === "true") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

let probe: CanvasRenderingContext2D | null | undefined;

/** Resolves any CSS colour (hex, rgb, display-p3, color-mix) to sRGB channels, or null. */
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

function readPalette(el: Element): AsciiPalette {
  const style = getComputedStyle(el);
  const base = resolveColor(style.getPropertyValue("--color-ink-tertiary")) ?? [0.55, 0.55, 0.55];
  const hot = resolveColor(style.getPropertyValue("--color-accent")) ?? base;
  const app = resolveColor(style.getPropertyValue("--color-app"));
  const light = app ? luminance(app) > 0.4 : false;
  return { base, hot, peak: light ? 0.32 : 0.28 };
}

function monoFont(el: Element): string {
  return getComputedStyle(el).getPropertyValue("--font-mono").trim() || MONO_FALLBACK;
}

/**
 * The drifting letter field behind an empty chat. Fills its nearest positioned
 * ancestor; give the content that should sit above it a position of its own.
 * Fades in while `active`, fades out and stops drawing when not.
 */
export function AsciiField({ active }: { active: boolean }) {
  const enabled = useAsciiBackground();
  if (!enabled) return null;
  return <AsciiCanvas active={active} />;
}

function AsciiCanvas({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  const kickRef = useRef<() => void>(() => {});
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    activeRef.current = active;
    kickRef.current();
  }, [active]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const renderer = createAsciiRenderer(canvas);
    if (!renderer) return;

    let palette = readPalette(canvas);
    let font = monoFont(canvas);
    let still = reducedMotion();
    let dpr = window.devicePixelRatio || 1;
    let fade = 0;
    let raf = 0;
    let last = 0;

    const size = () => {
      const box = canvas.getBoundingClientRect();
      renderer.resize(box.width, box.height, dpr, font);
    };

    const frame = (now: number) => {
      raf = 0;
      if (last && now - last < (document.hasFocus() ? FRAME_MS : UNFOCUSED_FRAME_MS) - 1) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = last ? Math.min(now - last, 100) : 0;
      last = now;
      if ((window.devicePixelRatio || 1) !== dpr) {
        dpr = window.devicePixelRatio || 1;
        size();
      }
      const target = activeRef.current ? 1 : 0;
      fade = still ? target : stepFade(fade, target, dt, FADE_MS);
      if (fade <= 0 && target === 0) {
        renderer.clear();
        last = 0;
        return;
      }
      const eased = fade * fade * (3 - 2 * fade);
      renderer.draw(still ? STILL_TIME : now / 1000 + CLOCK_OFFSET, eased, palette);
      if (still && fade === target) {
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
      palette = readPalette(canvas);
      font = monoFont(canvas);
      still = reducedMotion();
      size();
      kick();
    };

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
      resize.disconnect();
      root.disconnect();
      motion.removeEventListener("change", restyle);
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      renderer.dispose();
    };
  }, [generation]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      data-ascii-field=""
      className="pointer-events-none absolute inset-0 h-full w-full select-none"
      style={CLEAR_CENTER}
    />
  );
}

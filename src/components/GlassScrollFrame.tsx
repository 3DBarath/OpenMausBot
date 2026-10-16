import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { AsciiField } from "./AsciiField";

type GlassEdge = "top" | "bottom";

const EDGES: readonly GlassEdge[] = ["top", "bottom"];

function frameBars(frame: HTMLElement): Partial<Record<GlassEdge, HTMLElement>> {
  const bars: Partial<Record<GlassEdge, HTMLElement>> = {};
  for (const child of Array.from(frame.children)) {
    const edge = (child as HTMLElement).dataset?.glassBar;
    if (edge === "top" || edge === "bottom") bars[edge] = child as HTMLElement;
  }
  return bars;
}

export function publishGlassInsets(frame: HTMLElement): void {
  const bars = frameBars(frame);
  for (const edge of EDGES) {
    const bar = bars[edge];
    frame.style.setProperty(`--glass-${edge}`, `${bar ? Math.ceil(bar.getBoundingClientRect().height) : 0}px`);
  }
}

/**
 * `asciiField` draws the drifting letter field behind everything in the frame while true
 * (and fades it out when it turns false); leave it unset for no field. The scroller should be
 * positioned so its content paints above the field.
 */
export function GlassScrollFrame({ className, children, asciiField, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode; asciiField?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const apply = () => publishGlassInsets(frame);
    const resize = new ResizeObserver(apply);
    const watch = () => {
      resize.disconnect();
      for (const bar of Object.values(frameBars(frame))) if (bar) resize.observe(bar);
      apply();
    };
    watch();
    const children = new MutationObserver(watch);
    children.observe(frame, { childList: true });
    return () => {
      resize.disconnect();
      children.disconnect();
    };
  }, []);
  return (
    <div ref={ref} data-glass-frame="" className={cn("relative min-h-0", className)} {...rest}>
      {asciiField !== undefined && <AsciiField active={asciiField} />}
      {children}
    </div>
  );
}

export function GlassBar({ edge, className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { edge: GlassEdge; children: ReactNode }) {
  return (
    <div
      data-glass-bar={edge}
      className={cn("glass-bar absolute inset-x-0 z-10", edge === "top" ? "top-0" : "bottom-0", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export function GlassScroller({ className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={cn("glass-scroller h-full overflow-y-auto", className)} {...rest}>
      <div className="glass-scroller-content">{children}</div>
    </div>
  );
}

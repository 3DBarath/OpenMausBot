import { mixSrgb } from "./color-contrast";
import type { MausColor } from "./mascot";
import { userBubbleTone } from "./user-bubble-tone";

export const ASCII_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export const ASCII_CELL = { width: 7, height: 13, font: 11 } as const;

const FIELD_SCALE = 380;
const CLEAR_RADIUS = { x: 300, y: 150 } as const;

export type Rgb = readonly [number, number, number];

export interface AsciiTint {
  light: Rgb;
  deep: Rgb;
}

export interface AsciiPalette extends AsciiTint {
  base: Rgb;
  glow: Rgb;
  glowMix: number;
  peak: number;
}

export function hexRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function botTintHex(colors: readonly MausColor[]): { light: string; deep: string } | null {
  const [first, second] = colors;
  if (!first) return null;
  const tone = userBubbleTone(first);
  if (!second) return { light: mixSrgb("#ffffff", tone.background, 0.3), deep: mixSrgb("#000000", tone.deep, 0.12) };
  return { light: tone.background, deep: userBubbleTone(second).background };
}

export function botTint(colors: readonly MausColor[]): AsciiTint | null {
  const hex = botTintHex(colors);
  return hex && { light: hexRgb(hex.light), deep: hexRgb(hex.deep) };
}

export type AsciiMode = "empty" | "chat";

export interface AsciiLevel {
  brightness: number;
  clearCenter: number;
}

const LEVELS: Record<AsciiMode, AsciiLevel> = {
  empty: { brightness: 1, clearCenter: 1 },
  chat: { brightness: 0.55, clearCenter: 0 },
};

export function asciiLevel(mode: AsciiMode): AsciiLevel {
  return LEVELS[mode];
}

export interface AsciiGrid {
  cellWidth: number;
  cellHeight: number;
  cols: number;
  rows: number;
  width: number;
  height: number;
  dpr: number;
}

export function asciiGrid(cssWidth: number, cssHeight: number, dpr: number): AsciiGrid {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const cellWidth = Math.max(1, Math.round(ASCII_CELL.width * scale));
  const cellHeight = Math.max(1, Math.round(ASCII_CELL.height * scale));
  const width = Math.max(1, Math.round(Math.max(0, cssWidth) * scale));
  const height = Math.max(1, Math.round(Math.max(0, cssHeight) * scale));
  return {
    cellWidth,
    cellHeight,
    cols: Math.ceil(width / cellWidth),
    rows: Math.ceil(height / cellHeight),
    width,
    height,
    dpr: scale,
  };
}

export function stepFade(current: number, target: number, dtMs: number, durationMs: number): number {
  if (durationMs <= 0) return target;
  const step = Math.max(0, dtMs) / durationMs;
  const next = current < target ? Math.min(target, current + step) : Math.max(target, current - step);
  return Math.abs(next - target) < 1e-9 ? target : next;
}

export function stepLevel(current: AsciiLevel, target: AsciiLevel, dtMs: number, durationMs: number): AsciiLevel {
  return {
    brightness: stepFade(current.brightness, target.brightness, dtMs, durationMs),
    clearCenter: stepFade(current.clearCenter, target.clearCenter, dtMs, durationMs),
  };
}

export function sameLevel(a: AsciiLevel, b: AsciiLevel): boolean {
  return a.brightness === b.brightness && a.clearCenter === b.clearCenter;
}

export function luminance([r, g, b]: Rgb): number {
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

const VERTEX = `#version 300 es
precision highp float;

uniform vec2 u_canvas;
uniform vec2 u_cell;
uniform float u_cols;
uniform float u_field;
uniform float u_time;
uniform float u_glyphs;
uniform float u_brightness;
uniform float u_clear;
uniform vec2 u_clearRadius;

out vec2 v_uv;
out float v_alpha;
out float v_hot;
out float v_lit;
out float v_tint;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}

float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i++) {
    sum += amp * noise(p);
    p = p * 2.03 + vec3(17.1, 9.2, 3.7);
    amp *= 0.5;
  }
  return sum / 0.875;
}

float field(vec2 p, float t) {
  vec2 drift = vec2(t * 0.045, -t * 0.03);
  vec2 warp = vec2(fbm(vec3(p * 0.8 + drift, t * 0.09)), fbm(vec3(p * 0.8 + vec2(5.2, 1.3) - drift, t * 0.09 + 3.1)));
  return fbm(vec3(p + 1.7 * (warp - 0.5) + drift, t * 0.14));
}

void main() {
  float id = float(gl_InstanceID);
  vec2 cell = vec2(mod(id, u_cols), floor(id / u_cols));
  int v = gl_VertexID;
  vec2 corner = vec2(
    (v == 1 || v == 4 || v == 5) ? 1.0 : 0.0,
    (v == 2 || v == 3 || v == 5) ? 1.0 : 0.0);

  vec2 center = (cell + 0.5) * u_cell;
  vec2 p = center / u_field;
  float jitter = (hash(cell) - 0.5) * 0.05;
  float n = field(p, u_time) + jitter;
  float before = field(p, u_time - 0.8) + jitter;

  float swell = 0.5 + 0.5 * sin(u_time * 0.21) * sin(u_time * 0.13 + 1.7);
  float lo = 0.575 - 0.07 * swell;
  float lit = smoothstep(lo - 0.03, lo + 0.2, n);
  float hole = smoothstep(0.4, 1.0, length((center - u_canvas * vec2(0.5, 0.47)) / u_clearRadius));
  v_hot = smoothstep(0.004, 0.03, n - before) * smoothstep(lo + 0.02, lo + 0.16, n);
  v_alpha = lit * lit * u_brightness * mix(1.0, hole, u_clear);
  v_lit = lit;
  vec2 q = center / u_canvas;
  float sweep = ((1.0 - q.x) + q.y) * 0.5;
  v_tint = clamp(sweep + (fbm(vec3(p * 0.35 + 11.0, u_time * 0.05)) - 0.5) * 0.9, 0.0, 1.0);

  float rate = 0.12 + 0.4 * hash(cell + 7.7);
  float turn = floor(u_time * rate + hash(cell + 3.3) * 10.0);
  float glyph = floor(hash(cell + vec2(turn * 0.37, turn * 0.71)) * u_glyphs);
  v_uv = vec2((glyph + corner.x) / u_glyphs, corner.y);

  vec2 clip = (cell + corner) * u_cell / u_canvas * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = v_alpha < 0.004 ? vec4(2.0, 2.0, 0.0, 1.0) : vec4(clip, 0.0, 1.0);
}
`;

const FRAGMENT = `#version 300 es
precision mediump float;

uniform sampler2D u_atlas;
uniform vec3 u_base;
uniform vec3 u_light;
uniform vec3 u_deep;
uniform vec3 u_glow;
uniform float u_glowMix;
uniform float u_peak;

in vec2 v_uv;
in float v_alpha;
in float v_hot;
in float v_lit;
in float v_tint;

out vec4 outColor;

void main() {
  float cover = texture(u_atlas, v_uv).a;
  float a = min(1.0, cover * v_alpha * u_peak * (1.0 + 0.9 * v_hot));
  vec3 tint = mix(u_light, u_deep, v_tint);
  vec3 color = mix(u_base, tint, 0.6 + 0.4 * v_lit);
  color = mix(color, mix(tint, u_glow, u_glowMix), v_hot);
  outColor = vec4(color * a, a);
}
`;

export interface AsciiRenderer {
  resize(cssWidth: number, cssHeight: number, dpr: number, fontFamily: string): void;
  draw(time: number, level: AsciiLevel, palette: AsciiPalette): void;
  dispose(): void;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  console.warn("[ascii-field] shader:", gl.getShaderInfoLog(shader));
  gl.deleteShader(shader);
  return null;
}

function link(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = vertex && fragment ? gl.createProgram() : null;
  if (program && vertex && fragment) {
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
  }
  if (vertex) gl.deleteShader(vertex);
  if (fragment) gl.deleteShader(fragment);
  if (!program) return null;
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
  console.warn("[ascii-field] link:", gl.getProgramInfoLog(program));
  gl.deleteProgram(program);
  return null;
}

function drawAtlas(grid: AsciiGrid, fontFamily: string): HTMLCanvasElement | null {
  const atlas = document.createElement("canvas");
  atlas.width = grid.cellWidth * ASCII_GLYPHS.length;
  atlas.height = grid.cellHeight;
  const ctx = atlas.getContext("2d");
  if (!ctx) return null;
  ctx.font = `${Math.round(ASCII_CELL.font * grid.dpr)}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  for (let i = 0; i < ASCII_GLYPHS.length; i++) {
    ctx.fillText(ASCII_GLYPHS[i], (i + 0.5) * grid.cellWidth, grid.cellHeight / 2 + 0.5 * grid.dpr);
  }
  return atlas;
}

export function createAsciiRenderer(canvas: HTMLCanvasElement): AsciiRenderer | null {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (!gl) return null;
  const program = link(gl);
  if (!program) return null;
  const vao = gl.createVertexArray();
  const texture = gl.createTexture();
  const at = (name: string) => gl.getUniformLocation(program, name);
  const u = {
    canvas: at("u_canvas"),
    cell: at("u_cell"),
    cols: at("u_cols"),
    field: at("u_field"),
    time: at("u_time"),
    glyphs: at("u_glyphs"),
    brightness: at("u_brightness"),
    clear: at("u_clear"),
    clearRadius: at("u_clearRadius"),
    atlas: at("u_atlas"),
    base: at("u_base"),
    light: at("u_light"),
    deep: at("u_deep"),
    glow: at("u_glow"),
    glowMix: at("u_glowMix"),
    peak: at("u_peak"),
  };
  let grid: AsciiGrid | null = null;
  let atlasKey = "";

  return {
    resize(cssWidth, cssHeight, dpr, fontFamily) {
      if (gl.isContextLost()) return;
      grid = asciiGrid(cssWidth, cssHeight, dpr);
      if (canvas.width !== grid.width) canvas.width = grid.width;
      if (canvas.height !== grid.height) canvas.height = grid.height;
      const key = `${grid.cellWidth}x${grid.cellHeight}@${grid.dpr}:${fontFamily}`;
      if (key === atlasKey) return;
      const atlas = drawAtlas(grid, fontFamily);
      if (!atlas) return;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      atlasKey = key;
    },
    draw(time, level, palette) {
      if (!grid || !atlasKey || gl.isContextLost()) return;
      gl.viewport(0, 0, grid.width, grid.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(u.atlas, 0);
      gl.uniform2f(u.canvas, grid.width, grid.height);
      gl.uniform2f(u.cell, grid.cellWidth, grid.cellHeight);
      gl.uniform1f(u.cols, grid.cols);
      gl.uniform1f(u.field, FIELD_SCALE * grid.dpr);
      gl.uniform1f(u.time, time);
      gl.uniform1f(u.glyphs, ASCII_GLYPHS.length);
      gl.uniform1f(u.brightness, level.brightness);
      gl.uniform1f(u.clear, level.clearCenter);
      gl.uniform2f(u.clearRadius, CLEAR_RADIUS.x * grid.dpr, CLEAR_RADIUS.y * grid.dpr);
      gl.uniform3f(u.base, ...palette.base);
      gl.uniform3f(u.light, ...palette.light);
      gl.uniform3f(u.deep, ...palette.deep);
      gl.uniform3f(u.glow, ...palette.glow);
      gl.uniform1f(u.glowMix, palette.glowMix);
      gl.uniform1f(u.peak, palette.peak);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, grid.cols * grid.rows);
    },
    dispose() {
      if (gl.isContextLost()) return;
      gl.deleteTexture(texture);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}

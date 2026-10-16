// A field of monospace letters behind an empty chat. A slow, warped noise field
// lights letters up in drifting patches; where a patch is arriving the letters
// take the accent colour, and each letter swaps for another now and then.
//
// One instanced WebGL2 draw per frame: the vertex shader evaluates the field once
// per letter (not per pixel) and collapses unlit letters, and the fragment shader
// only samples a glyph atlas. The CPU sets a handful of uniforms.

export const ASCII_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Letter cell and font size in CSS pixels. */
export const ASCII_CELL = { width: 7, height: 13, font: 11 } as const;

/** How wide one patch of the field is, in CSS pixels. */
const FIELD_SCALE = 380;

export type Rgb = readonly [number, number, number];

export interface AsciiPalette {
  /** Lit letters. */
  base: Rgb;
  /** Letters where a patch is arriving. */
  hot: Rgb;
  /** Opacity of a fully lit letter. */
  peak: number;
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

/** Device-pixel grid for a canvas of the given CSS size. Cells are whole pixels so glyphs stay sharp. */
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

/** Moves `current` toward `target` (both 0..1) so a full change takes `durationMs`. */
export function stepFade(current: number, target: number, dtMs: number, durationMs: number): number {
  if (durationMs <= 0) return target;
  const step = Math.max(0, dtMs) / durationMs;
  const next = current < target ? Math.min(target, current + step) : Math.max(target, current - step);
  return Math.abs(next - target) < 1e-9 ? target : next;
}

/** WCAG relative luminance of an sRGB colour given as 0..1 channels. */
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
uniform float u_fade;

out vec2 v_uv;
out float v_alpha;
out float v_hot;

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

// Domain-warped fbm: the warp bends patches into the curved bands of the reference.
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

  vec2 p = (cell + 0.5) * u_cell / u_field;
  float jitter = (hash(cell) - 0.5) * 0.05;
  float n = field(p, u_time) + jitter;
  float before = field(p, u_time - 0.8) + jitter;

  // A slow swell so the whole field breathes between busy and almost empty.
  float swell = 0.5 + 0.5 * sin(u_time * 0.21) * sin(u_time * 0.13 + 1.7);
  float lo = 0.575 - 0.07 * swell;
  float lit = smoothstep(lo - 0.03, lo + 0.2, n);
  v_hot = smoothstep(0.004, 0.03, n - before) * smoothstep(lo + 0.02, lo + 0.16, n);
  v_alpha = lit * lit * u_fade;

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
uniform vec3 u_hot;
uniform float u_peak;

in vec2 v_uv;
in float v_alpha;
in float v_hot;

out vec4 outColor;

void main() {
  float cover = texture(u_atlas, v_uv).a;
  float a = min(1.0, cover * v_alpha * u_peak * (1.0 + 0.9 * v_hot));
  outColor = vec4(mix(u_base, u_hot, v_hot) * a, a);
}
`;

export interface AsciiRenderer {
  /** Sizes the canvas for its CSS box and redraws the glyph atlas when the cell or font changes. */
  resize(cssWidth: number, cssHeight: number, dpr: number, fontFamily: string): void;
  draw(time: number, fade: number, palette: AsciiPalette): void;
  clear(): void;
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

/** A renderer for `canvas`, or null when WebGL2 is unavailable (the field is then simply absent). */
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
    fade: at("u_fade"),
    atlas: at("u_atlas"),
    base: at("u_base"),
    hot: at("u_hot"),
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
    draw(time, fade, palette) {
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
      gl.uniform1f(u.fade, fade);
      gl.uniform3f(u.base, ...palette.base);
      gl.uniform3f(u.hot, ...palette.hot);
      gl.uniform1f(u.peak, palette.peak);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, grid.cols * grid.rows);
    },
    clear() {
      if (gl.isContextLost()) return;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    dispose() {
      if (gl.isContextLost()) return;
      gl.deleteTexture(texture);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}

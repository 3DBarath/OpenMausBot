import { describe, expect, it } from "vitest";

import { ASCII_CELL, ASCII_GLYPHS, asciiGrid, luminance, stepFade } from "./ascii-field";

describe("ascii field grid", () => {
  it("covers the whole canvas with whole-pixel cells", () => {
    const grid = asciiGrid(1000, 640, 2);
    expect(grid.width).toBe(2000);
    expect(grid.height).toBe(1280);
    expect(grid.cellWidth).toBe(ASCII_CELL.width * 2);
    expect(grid.cellHeight).toBe(ASCII_CELL.height * 2);
    expect(grid.cols * grid.cellWidth).toBeGreaterThanOrEqual(grid.width);
    expect(grid.rows * grid.cellHeight).toBeGreaterThanOrEqual(grid.height);
    expect((grid.cols - 1) * grid.cellWidth).toBeLessThan(grid.width);
  });

  it("rounds cells to whole device pixels on fractional displays", () => {
    const grid = asciiGrid(801, 333, 1.5);
    expect(Number.isInteger(grid.cellWidth)).toBe(true);
    expect(Number.isInteger(grid.cellHeight)).toBe(true);
    expect(Number.isInteger(grid.width)).toBe(true);
  });

  it("never sizes a canvas to zero, even before layout", () => {
    const grid = asciiGrid(0, 0, 0);
    expect(grid.width).toBe(1);
    expect(grid.height).toBe(1);
    expect(grid.cols).toBe(1);
    expect(grid.dpr).toBe(1);
  });

  it("draws letters and digits only", () => {
    expect(ASCII_GLYPHS).toMatch(/^[A-Za-z0-9]+$/);
    expect(new Set(ASCII_GLYPHS).size).toBe(ASCII_GLYPHS.length);
  });
});

describe("ascii field fade", () => {
  it("takes the full duration to go from hidden to shown and back", () => {
    let fade = 0;
    for (let i = 0; i < 6; i++) fade = stepFade(fade, 1, 100, 700);
    expect(fade).toBeCloseTo(6 / 7);
    fade = stepFade(fade, 1, 100, 700);
    expect(fade).toBe(1);
    fade = stepFade(fade, 1, 100, 700);
    expect(fade).toBe(1);
    fade = stepFade(fade, 0, 350, 700);
    expect(fade).toBeCloseTo(0.5);
    fade = stepFade(fade, 0, 10_000, 700);
    expect(fade).toBe(0);
  });

  it("stays put with no elapsed time and jumps with no duration", () => {
    expect(stepFade(0.3, 1, 0, 700)).toBe(0.3);
    expect(stepFade(0.3, 1, 16, 0)).toBe(1);
  });
});

describe("luminance", () => {
  it("tells a dark page from a light one", () => {
    expect(luminance([0, 0, 0])).toBe(0);
    expect(luminance([1, 1, 1])).toBeCloseTo(1);
    expect(luminance([7 / 255, 7 / 255, 7 / 255])).toBeLessThan(0.01);
    expect(luminance([253 / 255, 245 / 255, 234 / 255])).toBeGreaterThan(0.85);
  });
});

import { describe, expect, it } from "vitest";

import { ASCII_CELL, ASCII_GLYPHS, asciiGrid, asciiLevel, botTint, hexRgb, luminance, sameLevel, stepFade, stepLevel } from "./ascii-field";
import { userBubbleTone } from "./user-bubble-tone";

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

describe("ascii field level", () => {
  it("shows the field behind every chat, brightest and cleared in the middle while empty", () => {
    const empty = asciiLevel("empty");
    const chat = asciiLevel("chat");
    expect(empty).toEqual({ brightness: 1, clearCenter: 1 });
    expect(chat.brightness).toBeGreaterThan(0);
    expect(chat.brightness).toBeLessThan(empty.brightness);
    expect(chat.clearCenter).toBe(0);
  });

  it("eases both values from the empty look to the chat look together", () => {
    let level = asciiLevel("empty");
    level = stepLevel(level, asciiLevel("chat"), 350, 700);
    expect(level.clearCenter).toBeCloseTo(0.5);
    expect(level.brightness).toBeCloseTo(0.55);
    level = stepLevel(level, asciiLevel("chat"), 700, 700);
    expect(sameLevel(level, asciiLevel("chat"))).toBe(true);
  });
});

describe("ascii field tint", () => {
  const close = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

  it("reads hex colours as 0..1 channels", () => {
    expect(hexRgb("#ffffff")).toEqual([1, 1, 1]);
    expect(hexRgb("#000000")).toEqual([0, 0, 0]);
    expect(hexRgb("#377FE6")).toEqual([0x37 / 255, 0x7f / 255, 0xe6 / 255]);
  });

  it("runs a one-to-one chat from a lighter shade of the bot's colour to its deep shade", () => {
    const tint = botTint(["orange"]);
    const tone = userBubbleTone("orange");
    expect(tint).not.toBeNull();
    expect(luminance(tint!.deep)).toBeLessThan(luminance(hexRgb(tone.deep)));
    expect(luminance(tint!.light)).toBeGreaterThan(luminance(hexRgb(tone.background)));
    expect(luminance(tint!.light)).toBeGreaterThan(luminance(tint!.deep));
  });

  it("follows each bot's own colour", () => {
    expect(close(botTint(["green"])!.deep, botTint(["purple"])!.deep)).toBe(false);
  });

  it("blends the first two members' colours in a room", () => {
    const tint = botTint(["blue", "green", "red"]);
    expect(close(tint!.light, hexRgb(userBubbleTone("blue").background))).toBe(true);
    expect(close(tint!.deep, hexRgb(userBubbleTone("green").background))).toBe(true);
  });

  it("has no tint without a bot, so the skin accent is used", () => {
    expect(botTint([])).toBeNull();
  });
});

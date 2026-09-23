import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTime, toFrame, formatTc } from "../src/core/time.ts";

const ctx = { fps: 30, grid: { bpm: 120, offset: 0.1 } };

test("seconds, frames and beats", () => {
  assert.equal(parseTime(1.5, ctx, "position"), 1.5);
  assert.equal(parseTime("2s", ctx, "position"), 2);
  assert.equal(parseTime("45f", ctx, "position"), 1.5);
  assert.equal(parseTime("4b", ctx, "position"), 2.1); // offset applies to positions
  assert.equal(parseTime("4b", ctx, "length"), 2); // not to lengths
});

test("sums", () => {
  assert.equal(parseTime("4b+15f", ctx, "position"), 2.6);
  assert.ok(Math.abs(parseTime("32b-0.3s", ctx, "position") - 15.8) < 1e-9);
});

test("beats without a grid fail loudly with a hint", () => {
  assert.throws(() => parseTime("4b", { fps: 30 }, "position"), (e: any) => e.code === "no_grid" && /grid/.test(e.hint));
});

test("garbage is rejected", () => {
  assert.throws(() => parseTime("4 beats", ctx, "position"), (e: any) => e.code === "bad_time");
});

test("frame rounding is deterministic (half up)", () => {
  assert.equal(toFrame(0.5 / 30, 30), 1);
  assert.equal(toFrame(4.05, 30), 122);
  assert.equal(formatTc(61.5, 30), "00:01:01:15");
});

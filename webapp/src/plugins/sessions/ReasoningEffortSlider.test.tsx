import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../../i18n";
import {
  ReasoningEffortPanel,
  ReasoningEffortSlider,
  reasoningEffortLabel,
  normalizeReasoningLevels,
  reasoningSliderFillColor,
  reasoningSliderFillBackground,
  reasoningSliderEnergy,
  reasoningSliderSpeed,
  reasoningSliderParticleCount,
  reasoningSliderValueColor,
  reasoningSliderIsOffLevel,
  REASONING_SLIDER_REDUCED_MOTION_SLOWDOWN,
} from "./ReasoningEffortSlider";

test("reasoning panel exposes only supported API levels, with a separate provider default", () => {
  const html = renderToStaticMarkup(<ReasoningEffortPanel levels={["none", "low", "high"]}
    value="high" modelName="DeepSeek" onChange={() => {}} onConfigure={() => {}} />);
  assert.match(html, /role="slider"/);
  assert.match(html, /aria-valuemax="3"/);
  assert.match(html, /aria-valuenow="3"/);
  assert.match(html, /aria-valuetext="高"/);
  assert.doesNotMatch(html, /Ultra|Max|最高/);
  assert.match(html, /恢复默认思考强度/);
});

test("unknown reasoning metadata gives a configuration entry without invented effort stops", () => {
  const html = renderToStaticMarkup(<ReasoningEffortPanel levels={[]} value={undefined}
    modelName="Custom model" onChange={() => {}} onConfigure={() => {}} />);
  assert.doesNotMatch(html, /role="slider"/);
  assert.match(html, /当前使用服务默认/);
  assert.match(html, /配置模型推理档位/);
});

test("single supported level remains adjustable from default and the locked slider is unfocusable", () => {
  const html = renderToStaticMarkup(<ReasoningEffortSlider levels={["high"]} value="high" disabled onChange={() => {}} />);
  assert.match(html, /aria-valuemax="1"/);
  assert.match(html, /aria-valuenow="1"/);
  assert.match(html, /tabindex="-1"/);
  assert.match(html, /aria-disabled="true"/);
});

test("reasoning labels distinguish every backend value in English", () => {
  setLocale("en");
  try {
    assert.deepEqual([undefined, "none", "minimal", "low", "medium", "high", "xhigh", "max"].map(reasoningEffortLabel),
      ["Default", "Off", "Minimal", "Low", "Medium", "High", "Extra high", "Max"]);
  } finally { setLocale("zh"); }
});

test("normalizeReasoningLevels removes blank and duplicate stops in first-seen order", () => {
  assert.deepEqual(normalizeReasoningLevels(["", "low", " low ", "low", "high"]), ["low", "high"]);
  assert.deepEqual(normalizeReasoningLevels(undefined), []);
});

test("reasoningSliderEnergy: zero before the second stop, ramps to 1 at max", () => {
  assert.equal(reasoningSliderEnergy(0), 0);
  assert.equal(reasoningSliderEnergy(1 / 3), 0);
  assert.ok(reasoningSliderEnergy(2 / 3) > 0.49 && reasoningSliderEnergy(2 / 3) < 0.51);
  assert.equal(reasoningSliderEnergy(1), 1);
});

test("reasoningSliderFillColor: blue at the left, violet mid, deep purple at max", () => {
  assert.equal(reasoningSliderFillColor(0), "rgb(77, 147, 248)");
  assert.equal(reasoningSliderFillColor(1 / 3), "rgb(77, 147, 248)");
  assert.equal(reasoningSliderFillColor(1), "rgb(76, 29, 149)");
  // Mid-energy blends blue toward violet.
  const mid = reasoningSliderFillColor(0.5);
  assert.match(mid, /^rgb\(\d+, \d+, \d+\)$/);
  assert.notEqual(mid, "rgb(77, 147, 248)");
});

test("reasoningSliderFillBackground: left end always blue", () => {
  const bg = reasoningSliderFillBackground(1);
  assert.ok(bg.startsWith("linear-gradient(90deg, rgb(77, 147, 248), "));
});

test("reasoningSliderSpeed: bounded 0.35x..2x", () => {
  assert.equal(reasoningSliderSpeed(0), 0.35);
  assert.equal(reasoningSliderSpeed(1), 2);
  const high = reasoningSliderSpeed(2 / 3);
  assert.ok(high > 0.9 && high < 1.1);
});

test("reasoningSliderParticleCount: 0 at low end, 22 at max", () => {
  assert.equal(reasoningSliderParticleCount(0), 0);
  assert.equal(reasoningSliderParticleCount(1 / 3), 0);
  assert.equal(reasoningSliderParticleCount(1), 22);
});

test("reasoningSliderIsOffLevel: recognizes off synonyms", () => {
  assert.equal(reasoningSliderIsOffLevel("none"), true);
  assert.equal(reasoningSliderIsOffLevel("off"), true);
  assert.equal(reasoningSliderIsOffLevel("OFF"), true);
  assert.equal(reasoningSliderIsOffLevel("关闭"), true);
  assert.equal(reasoningSliderIsOffLevel("high"), false);
  assert.equal(reasoningSliderIsOffLevel(undefined), false);
  assert.equal(reasoningSliderIsOffLevel(""), false);
});

test("reasoningSliderValueColor: empty for off levels, tinted otherwise", () => {
  assert.equal(reasoningSliderValueColor(1, "none"), "");
  assert.equal(reasoningSliderValueColor(0.5, "off"), "");
  const colored = reasoningSliderValueColor(1, "high");
  assert.match(colored, /^rgb\(\d+, \d+, \d+\)$/);
  assert.notEqual(colored, "");
});

test("reasoningSlider: reduced-motion slowdown constant is sane", () => {
  assert.ok(REASONING_SLIDER_REDUCED_MOTION_SLOWDOWN > 1);
});

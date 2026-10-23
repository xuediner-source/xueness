import test from "node:test";
import assert from "node:assert/strict";
import { proseWithoutVisualizations, splitVisualizations, visualizationUrl } from "./Visualizations";

test("visualization references split prose outside code fences only", () => {
  const text = [
    "Intro",
    '::visualize{"path":"/tmp/viz/Sales Chart.html","mode":"wide"}',
    "```",
    '::visualize{"path":"/tmp/viz/fenced.html"}',
    "```",
    '::visualize{path="/tmp/viz/legacy.html"}',
    '::visualize{"path":"relative.html"}',
    "Outro",
  ].join("\n");
  const segments = splitVisualizations(text);
  assert.deepEqual(segments.map((segment) => segment.kind), ["markdown", "visualization", "markdown", "visualization", "markdown"]);
  assert.deepEqual(segments[1], { kind: "visualization", reference: { path: "/tmp/viz/Sales Chart.html", wide: true } });
  assert.deepEqual(segments[3], { kind: "visualization", reference: { path: "/tmp/viz/legacy.html", wide: false } });
  assert.match(proseWithoutVisualizations(segments), /fenced\.html[\s\S]*relative\.html[\s\S]*Outro/);
  assert.deepEqual(splitVisualizations("plain"), [{ kind: "markdown", text: "plain" }]);
});

test("visualization URLs carry the path and optional title", () => {
  assert.equal(visualizationUrl({ path: "/a b.html", wide: false }), "/api/visualizations?path=%2Fa+b.html");
  assert.equal(visualizationUrl({ path: "/a.html", title: "T", wide: false }), "/api/visualizations?path=%2Fa.html&title=T");
});

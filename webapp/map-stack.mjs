import { readFileSync } from "node:fs";
import { SourceMapConsumer } from "source-map";

const mapPath = process.argv[2];
const positions = JSON.parse(process.argv[3]);

const raw = JSON.parse(readFileSync(mapPath, "utf8"));
let consumer;
try {
  consumer = await new SourceMapConsumer(raw);
} catch {
  consumer = new SourceMapConsumer(raw);
}

for (const [line, col] of positions) {
  const orig = consumer.originalPositionFor({ line, column: col });
  const where = orig.source
    ? `${orig.source}:${orig.line}:${orig.column}`
    : "<unmapped>";
  console.log(`${line}:${col}  ->  ${where}  ${orig.name ? `(${orig.name})` : ""}`);
}

if (typeof consumer.destroy === "function") consumer.destroy();

import test from "node:test";
import assert from "node:assert/strict";
import { StreamingRevealPacer, streamingRevealBoundary } from "./StreamingCommitGate";

/** Feed `chars` every `every` ms until `until`, ticking at 32 ms; return the shown length per tick. */
function drive(pacer: StreamingRevealPacer, arrivals: Array<[number, number]>, until: number, tick = 32): Array<[number, number]> {
  const shown: Array<[number, number]> = [];
  let next = 0;
  for (let now = 0; now <= until; now += tick) {
    while (next < arrivals.length && arrivals[next][0] <= now) {
      pacer.setTarget("流".repeat(arrivals[next][1]), arrivals[next][0], true);
      next += 1;
    }
    pacer.advance(now);
    shown.push([now, pacer.visible().length]);
  }
  return shown;
}

function steady(every: number, chars: number, from: number, until: number, start = 0): Array<[number, number]> {
  const arrivals: Array<[number, number]> = [];
  for (let at = from, total = start; at <= until; at += every) arrivals.push([at, (total += chars)]);
  return arrivals;
}

test("StreamingRevealPacer: 稳定到达时按平均到达速度匀速显示，不随每批文字忽快忽慢", () => {
  const pacer = new StreamingRevealPacer("", true);
  // 6 characters every 40 ms (0.15 per ms); a 32 ms frame does not divide the arrival gap.
  const shown = drive(pacer, steady(40, 6, 0, 3000), 3000);
  const steps = shown.slice(1).map(([at, length], index) => [at, length - shown[index][1]]).filter(([at]) => at >= 800);
  for (const [, step] of steps) assert.ok(step >= 3 && step <= 7, `even per-frame step, got ${step}`);
  const window = shown.filter(([at]) => at >= 1000 && at <= 2600);
  const speed = (window[window.length - 1][1] - window[0][1]) / (window[window.length - 1][0] - window[0][0]);
  assert.ok(Math.abs(speed - 0.15) < 0.01, `reveal speed follows the arrival speed, got ${speed}`);
  const lag = 3000 * 0.15 - shown[shown.length - 1][1];
  assert.ok(lag > 0 && lag < 0.15 * 250, `a small reserve trails the arrivals, got ${lag}`);
});

test("StreamingRevealPacer: 到达速度突增时追上来，落后有上限", () => {
  const pacer = new StreamingRevealPacer("", true);
  const slow = steady(40, 2, 0, 1000);
  const fast = steady(40, 40, 1040, 3000, slow[slow.length - 1][1]);
  const shown = drive(pacer, [...slow, ...fast], 3000);
  const received = fast[fast.length - 1][1];
  const behind = received - shown[shown.length - 1][1];
  // Arrivals run at 1 unit per ms: the reveal trails them by well under half a second.
  assert.ok(behind < 400, `bounded lag after a speed-up, got ${behind}`);
});

test("StreamingRevealPacer: 到达暂停时放慢收尾并显示完，不会一下停住", () => {
  const pacer = new StreamingRevealPacer("", true);
  const shown = drive(pacer, steady(40, 6, 0, 1000), 1800);
  const steps = shown.slice(1).map(([at, length], index) => [at, length - shown[index][1]]);
  const steadyStep = steps.filter(([at]) => at > 600 && at <= 1000).reduce((sum, [, step]) => sum + step, 0) / 12.5;
  const tail = steps.filter(([at, step]) => at > 1000 && step > 0);
  assert.ok(tail.length >= 3, "the reserve drains over several frames");
  assert.ok(tail[tail.length - 1][1] < steadyStep, "the last frames slow down instead of stopping abruptly");
  assert.equal(pacer.done, true, "everything received is shown during the pause");
  assert.ok(tail[tail.length - 1][0] <= 1600, `drained within the pause, last at ${tail[tail.length - 1][0]}`);
});

test("StreamingRevealPacer: 追上之后的新文字从到达时刻开始显示，不会一次补完", () => {
  const pacer = new StreamingRevealPacer("", true);
  drive(pacer, steady(40, 6, 0, 600), 1500);
  assert.equal(pacer.done, true);
  const before = pacer.visible().length;
  pacer.setTarget("流".repeat(before + 60), 5000, true);
  pacer.advance(5032);
  const step = pacer.visible().length - before;
  assert.ok(step > 0 && step < 30, `paced from the arrival, got ${step}`);
});

test("StreamingRevealPacer: 挂载时已有的文字直接显示，定稿后的编辑也立即显示", () => {
  const pacer = new StreamingRevealPacer("历史回答", false);
  assert.equal(pacer.done, true);
  assert.equal(pacer.visible(), "历史回答");
  pacer.setTarget("历史回答（已编辑）", 10, false);
  assert.equal(pacer.visible(), "历史回答（已编辑）");
});

test("StreamingRevealPacer: 收流后在约 200 ms 内把剩余文字显示完，而不是一次弹出", () => {
  const pacer = new StreamingRevealPacer("开头", true);
  pacer.setTarget("开头，然后是一长段尚未显示的结尾文字", 0, true);
  pacer.advance(20);
  pacer.setTarget("开头，然后是一长段尚未显示的结尾文字", 30, false);
  assert.equal(pacer.done, false, "the settled text keeps revealing");
  pacer.advance(120);
  assert.equal(pacer.done, false);
  pacer.advance(260);
  assert.equal(pacer.done, true);
  assert.equal(pacer.visible(), "开头，然后是一长段尚未显示的结尾文字");
});

test("StreamingRevealPacer: 改写已显示的部分时只保留公共前缀", () => {
  const pacer = new StreamingRevealPacer("答案是 4", true);
  pacer.setTarget("答案是 42。", 0, true);
  pacer.advance(1000);
  pacer.setTarget("答案是 41。补充", 1010, true);
  assert.equal(pacer.visible(), "答案是 4");
  pacer.advance(2000);
  assert.equal(pacer.visible(), "答案是 41。补充");
});

test("StreamingRevealPacer: 积压过多时直接显示", () => {
  const pacer = new StreamingRevealPacer("", true);
  const long = "字".repeat(5000);
  pacer.setTarget(long, 0, true);
  assert.equal(pacer.visible(), long);
});

test("streamingRevealBoundary: 不拆代理对、组合字符和成串的 Markdown 标记", () => {
  assert.equal(streamingRevealBoundary("a😀b", 2), 3);
  assert.equal(streamingRevealBoundary("e\u0301x", 1), 2);
  assert.equal(streamingRevealBoundary("**粗体**", 1), 2);
  assert.equal(streamingRevealBoundary("```ts\n", 1), 3);
  assert.equal(streamingRevealBoundary("普通文字", 2), 2);
  assert.equal(streamingRevealBoundary("短", 5), 1);
});

test("StreamingRevealPacer: finish 立即显示已收到的全部文字（减少动态效果）", () => {
  const pacer = new StreamingRevealPacer("", true);
  pacer.setTarget("第一批文字已经到达，", 0, true);
  assert.equal(pacer.done, false);
  pacer.finish();
  assert.equal(pacer.done, true);
  assert.equal(pacer.visible(), "第一批文字已经到达，");
  pacer.setTarget("第一批文字已经到达，第二批也到了", 300, true);
  pacer.finish();
  assert.equal(pacer.visible(), "第一批文字已经到达，第二批也到了");
});

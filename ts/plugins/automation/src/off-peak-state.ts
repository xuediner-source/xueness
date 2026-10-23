/**
 * The off-peak queue's durable layer (Python `off_peak._lock`,
 * `OffPeakQueue._read`/`_write`/`_stop_workflow`, `add`'s validation and
 * `resources._atomic_write_json`).
 *
 * Everything here concerns one state directory: the queue's own flock, the
 * bounded JSON read that refuses symlinks, the private atomic replacement, the
 * stop a cancelled task performs on the workflow behind it, and the validation
 * that turns a request body into a task row.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isDict, pyEncodeUtf8, pyJsonDumps, pyJsonLoadsBytes, pyStr, pyTruthy, PyValueError, uuid4Hex,
} from "@xueness/contracts";
import {
  fsyncDirectory, isLink, isPyKeyError, isPyOSError, isPyValueError, mkstemp, protectPrivateFile, replaceFile,
  withFileLockSync, writeAll,
} from "@xueness/sessions";
import {
  ADD_FIELDS, DEFAULT_DEADLINE, isDirectory, LOCK_FILE, MAX_DEADLINE, MAX_MODEL_TEXT, MAX_NAME, MAX_PROMPT,
  MIN_DEADLINE, pick, planFor, pyIsAbsolute, resolvePath, text, timestamp, unknownFields, windowBounds, zoneOf,
  type Row, type WorkflowBridge,
} from "./off-peak.ts";

/** `_lock(state)`: the queue's own flock, never the plugin switch lock. */
export function withQueueLock<T>(state: string, body: () => T): T {
  mkdirSync(state, { recursive: true });
  const path = join(state, LOCK_FILE);
  if (isLink(path)) throw new PyValueError("闲时队列锁不能是符号链接");
  return withFileLockSync(path, {}, body);
}

/**
 * `_read(path, maximum, kind)`. `undefined` stands in for Python's `None`, so a
 * missing file and a document that is literally `null` read alike, which is what
 * every caller does with the result. Lossless decoding keeps `1.0` a float and
 * `1` an int, so a rewritten file matches the bytes Python would produce.
 */
export function readStateFile(path: string, maximum: number, kind: string): unknown {
  if (isLink(path)) throw new PyValueError(`闲时${kind}不能是符号链接`);
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (raw.length > maximum) throw new PyValueError(`闲时${kind}超出大小上限`);
  try {
    return pyJsonLoadsBytes(raw, { lossless: true }) ?? undefined;
  } catch (error) {
    if (!isPyValueError(error)) throw error;
    throw new PyValueError(`闲时${kind}已损坏，请先修复或删除该状态文件`);
  }
}

/** `_atomic_write_json`: private temp file, fsync, replace, then fsync the directory. */
export function writeStateJson(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temp = mkstemp(directory, ".resource-");
  try {
    try {
      protectPrivateFile(temp.fd);
      writeAll(temp.fd, pyEncodeUtf8(pyJsonDumps(value, { ensureAscii: false, indent: 2 })));
      fsyncSync(temp.fd);
    } finally {
      closeSync(temp.fd);
    }
    replaceFile(temp.path, path);
  } finally {
    if (existsSync(temp.path)) unlinkSync(temp.path);
  }
  try {
    fsyncDirectory(directory);
  } catch {
    // Durability of the rename itself is best effort, as Python's is.
  }
}

/** `_stop_workflow`: cancel a run, or mark a not-yet-launched one cancelled. */
export function stopWorkflow(bridge: WorkflowBridge, workflowId: unknown): void {
  const wid = pyStr(workflowId);
  try {
    bridge.control(wid, "cancel");
  } catch (error) {
    if (!isPyValueError(error)) {
      // `except (OSError, KeyError): pass`
      if (isPyOSError(error) || isPyKeyError(error)) return;
      throw error;
    }
    // Cancellation may reach the workflow before launch has changed its created
    // state. Preserve that decision without starting it. Python reaches into
    // `WorkflowStore.update`; the §4 bridge may not expose it, and then a run
    // cancelled before launch simply keeps its `created` status.
    const extras = bridge as WorkflowBridge & {
      update?(wid: string, change: (record: Row) => void): Row;
      event?(record: Row, kind: string): void;
    };
    if (typeof extras.update !== "function") return;
    try {
      extras.update.call(bridge, wid, (record) => {
        if (pick(record, "status") !== "created") return;
        record.status = "cancelled";
        record.control = "cancel";
        extras.event?.call(bridge, record, "cancel");
      });
    } catch (inner) {
      if (!isPyOSError(inner) && !isPyKeyError(inner) && !isPyValueError(inner)) throw inner;
    }
  }
}

/**
 * `OffPeakQueue.add`'s validation and row construction, in Python's order:
 * `ADD_FIELDS`, `_text` bounds, an absolute existing root, the deadline bounds,
 * the three literal booleans, the optional window and time zone, and the digest
 * the approval binds to.
 */
export function buildTaskRow(data: Row, now: number): Row {
  const unknown = unknownFields(data, ADD_FIELDS);
  if (unknown.length) throw new PyValueError("闲时任务包含未知字段: " + unknown.join(", "));
  const prompt = text(pick(data, "prompt"), "提示词", MAX_PROMPT, true) as string;
  const name = text(pick(data, "name"), "任务名称", MAX_NAME) ?? "闲时任务";
  const rootValue = text(pick(data, "root"), "工作区路径", 4096, true) as string;
  if (!pyIsAbsolute(rootValue)) throw new PyValueError("工作区路径需要是绝对路径");
  const root = resolvePath(rootValue);
  if (!isDirectory(root)) throw new PyValueError("工作区目录不存在");
  const model = text(pick(data, "model"), "模型", MAX_MODEL_TEXT);
  const providerId = text(pick(data, "provider_id"), "服务商", MAX_MODEL_TEXT);
  const deadline = Object.hasOwn(data, "deadlineSeconds") ? data.deadlineSeconds : DEFAULT_DEADLINE;
  // `type(deadline) is not int`: a bool is not an int here, and neither is a float.
  if (typeof deadline !== "number" || !Number.isInteger(deadline) || deadline < MIN_DEADLINE || deadline > MAX_DEADLINE) {
    throw new PyValueError(`闲时任务超时需要是 ${MIN_DEADLINE} 到 ${MAX_DEADLINE} 秒的整数`);
  }
  const booleans = [["onlyWhenIdle", "仅在空闲时"], ["confirm", "批准无人值守执行"], ["allowReal", "允许真实服务商"]] as const;
  for (const [field, label] of booleans) {
    if (typeof (Object.hasOwn(data, field) ? data[field] : false) !== "boolean") {
      throw new PyValueError(`${label}需要是布尔值`);
    }
  }
  let window: Row | null = null;
  const rawWindow = pick(data, "window");
  if (rawWindow !== null) {
    // Python coerces a non-dict to `{'start': None}`, so the error names the start
    // bound rather than the container.
    const candidate = isDict(rawWindow) ? rawWindow : { start: null };
    windowBounds(candidate);
    window = { start: candidate.start, end: candidate.end };
  }
  let timezoneName: unknown = null;
  const rawZone = pick(data, "timezone");
  if (rawZone !== null) {
    zoneOf(rawZone);
    timezoneName = pyTruthy(rawZone) ? rawZone : null;
  }
  const row: Row = {
    id: uuid4Hex(), name, prompt, root, model, provider_id: providerId, deadlineSeconds: deadline,
    onlyWhenIdle: pick(data, "onlyWhenIdle") === true, window, timezone: timezoneName, status: "queued",
    createdAt: timestamp(now), nextEligibleAt: timestamp(now), holdUntil: null,
    approved: pick(data, "confirm") === true, allowReal: pick(data, "allowReal") === true,
    runId: null, workflowId: null, claimedAt: null, finishedAt: null, history: [],
  };
  row.digest = pick(planFor(row), "digest");
  return row;
}
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pyJsonDumps } from "@xueness/contracts";
import { pyExceptionName, SessionStore, storeStage } from "../src/index.ts";
import { pythonUnavailableReason } from "../../../test-support/python-oracle.ts";
import { tempDir } from "./fixtures.ts";
import { oracle } from "./oracle.ts";

const skip = pythonUnavailableReason() ?? false;
type Row = Record<string, unknown>;

function clean(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function capture(error: unknown): { error: string; stage: unknown } {
  return { error: pyExceptionName(error), stage: storeStage(error) };
}

describe("session store file selection and failures", { skip }, () => {
  it("lists valid journals and skips malformed, incomplete, and non-file entries", async () => {
    const directory = tempDir("list-abnormal");
    try {
      const validId = "00000000000000000000000000000001";
      const malformedId = "00000000000000000000000000000002";
      const wrongId = "00000000000000000000000000000003";
      const missingTaskId = "00000000000000000000000000000004";
      const missingStatusId = "00000000000000000000000000000005";
      const nonObjectId = "00000000000000000000000000000006";
      const directoryId = "00000000000000000000000000000007";
      const put = (id: string, value: unknown) => writeFileSync(join(directory, `${id}.json`), pyJsonDumps(value, { indent: 2 }));

      put(validId, { id: validId, task: "kept", status: "pending" });
      writeFileSync(join(directory, `${malformedId}.json`), "{".repeat(5));
      put(wrongId, { id: validId, task: "wrong id", status: "pending" });
      put(missingTaskId, { id: missingTaskId, status: "pending" });
      put(missingStatusId, { id: missingStatusId, task: "missing status" });
      put(nonObjectId, ["not", "a", "session"]);
      mkdirSync(join(directory, `${directoryId}.json`));
      writeFileSync(join(directory, "ignored.json.bak"), "{}{}");

      const actual = await new SessionStore(directory).list();
      const expected = oracle({ op: "list", directory });
      assert.deepEqual(actual, expected);
      assert.deepEqual(actual, [{ id: validId, task: "kept", status: "pending" }]);
    } finally {
      clean(directory);
    }
  });

  it("skips a linked journal when the platform permits creating one", async (t) => {
    const directory = tempDir("list-linked");
    try {
      const validId = "00000000000000000000000000000011";
      const linkId = "00000000000000000000000000000012";
      writeFileSync(join(directory, `${validId}.json`), pyJsonDumps({ id: validId, task: "kept", status: "pending" }));
      // If followed, this target would be a valid journal for linkId. A
      // mismatched id would mask a regression in the link protection.
      const target = join(directory, "link-target.data");
      writeFileSync(target, pyJsonDumps({ id: linkId, task: "linked", status: "pending" }));
      try {
        symlinkSync(target, join(directory, `${linkId}.json`), "file");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
          t.skip("Windows did not allow creating a file symlink");
          return;
        }
        throw error;
      }

      const actual = await new SessionStore(directory).list();
      const expected = oracle({ op: "list", directory });
      assert.deepEqual(actual, expected);
      assert.deepEqual(actual, [{ id: validId, task: "kept", status: "pending" }]);
    } finally {
      clean(directory);
    }
  });

  it("matches Python save errors and the annotated failure stages", async () => {
    const directory = tempDir("save-errors");
    try {
      const sessions: Row[] = [
        {},
        { id: 7 },
        { id: "invalid" },
        { id: "0123456789abcdef0123456789abcdef", messages: [], invalidText: "\ud800" },
      ];
      const expected = oracle({ op: "save", directory, sessions }) as Row[];
      const store = new SessionStore(directory);
      const actual: Row[] = [];
      for (const session of sessions) {
        try {
          await store.save(session);
          actual.push({ ok: true });
        } catch (error) {
          actual.push({ ok: false, ...capture(error) });
        }
      }
      assert.deepEqual(actual, expected);
      assert.deepEqual(expected.map((item) => item.stage), ["session_path", "session_path", "session_path", "lock"]);
    } finally {
      clean(directory);
    }
  });

  it("matches Python load and new error classes", async () => {
    const directory = tempDir("load-new-errors");
    try {
      const ids: unknown[] = ["invalid", "0123456789abcdef0123456789abcdef", 3];
      const expectedLoads = oracle({ op: "load", directory, ids }) as Row[];
      const store = new SessionStore(directory);
      const actualLoads: Row[] = [];
      for (const id of ids) {
        try {
          await store.load(id as string);
          actualLoads.push({ ok: true });
        } catch (error) {
          actualLoads.push({ error: pyExceptionName(error) });
        }
      }
      assert.deepEqual(actualLoads, expectedLoads);

      const invalidIds: unknown[] = [7, "invalid"];
      for (const sessionId of invalidIds) {
        const expected = oracle({ op: "new", directory, root: directory, task: "task", session_id: sessionId }) as Row;
        let actual: Row;
        try {
          await store.new("task", directory, { sessionId: sessionId as string });
          actual = { ok: true };
        } catch (error) {
          actual = { error: pyExceptionName(error) };
        }
        assert.deepEqual(actual, expected);
      }
    } finally {
      clean(directory);
    }
  });
});

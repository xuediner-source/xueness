import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderCancelled } from "../src/errors.ts";
import { admitAttempt, type ModelRequestAdmissionTicket, type ModelRequestTarget } from "../src/request-admission.ts";

const model: ModelRequestTarget = { providerId: "local-provider", modelId: "local-model" };

function ticket(onRelease: () => void): ModelRequestAdmissionTicket {
  return { release: onRelease };
}

describe("provider request admission", () => {
  it("keeps no-admission and fast-path admission free of queue observer events", async () => {
    let observed = 0;
    const observer = async () => { observed += 1; };
    const absent = await admitAttempt({ model, onQueued: observer, onAdmitted: observer });
    absent.release();
    absent.release();
    assert.equal(absent.ticket, undefined);
    assert.equal(observed, 0);

    let releases = 0;
    let slowAcquires = 0;
    const fast = await admitAttempt({ model, onQueued: observer, onAdmitted: observer, admission: {
      tryAcquire: ({ model: requested }) => {
        assert.deepEqual(requested, model);
        return ticket(() => { releases += 1; });
      },
      acquire: async () => { slowAcquires += 1; throw new Error("fast path must not queue"); },
    } });
    assert.ok(fast.ticket);
    assert.equal(observed, 0);
    assert.equal(slowAcquires, 0);
    fast.release();
    fast.release();
    assert.equal(releases, 1);
  });

  it("orders queued slow-path observers and skips them without a fast-path API", async () => {
    const order: string[] = [];
    const first = await admitAttempt({ model,
      onQueued: async () => { order.push("queued"); },
      onAdmitted: async (queuedMs) => { assert.ok(Number.isFinite(queuedMs) && queuedMs >= 0); order.push("admitted"); },
      admission: {
        tryAcquire: () => { order.push("try"); return undefined; },
        acquire: async ({ model: requested }) => { assert.deepEqual(requested, model); order.push("acquire"); return ticket(() => order.push("release")); },
      },
    });
    assert.deepEqual(order, ["try", "queued", "acquire", "admitted"]);
    first.release();
    first.release();
    assert.deepEqual(order, ["try", "queued", "acquire", "admitted", "release"]);

    const withoutFastPath: string[] = [];
    const second = await admitAttempt({ model,
      onQueued: async () => { withoutFastPath.push("queued"); },
      onAdmitted: async () => { withoutFastPath.push("admitted"); },
      admission: { acquire: async () => { withoutFastPath.push("acquire"); return ticket(() => withoutFastPath.push("release")); } },
    });
    assert.deepEqual(withoutFastPath, ["acquire"]);
    second.release();
    assert.deepEqual(withoutFastPath, ["acquire", "release"]);
  });

  it("rejects pre-abort and releases a grant that crosses the abort boundary", async () => {
    const before = new AbortController();
    before.abort("caller reason");
    let acquired = 0;
    await assert.rejects(admitAttempt({ model, signal: before.signal, admission: {
      tryAcquire: () => { acquired += 1; return undefined; },
      acquire: async () => { acquired += 1; return ticket(() => undefined); },
    } }), ProviderCancelled);
    assert.equal(acquired, 0);

    const during = new AbortController();
    let releases = 0;
    let admitted = 0;
    await assert.rejects(admitAttempt({ model, signal: during.signal,
      onQueued: async () => undefined,
      onAdmitted: async () => { admitted += 1; },
      admission: {
        tryAcquire: () => undefined,
        acquire: async () => {
          during.abort("late grant");
          return ticket(() => { releases += 1; });
        },
      },
    }), ProviderCancelled);
    assert.equal(admitted, 0);
    assert.equal(releases, 1);
  });

  it("does not acquire after onQueued fails and releases after onAdmitted fails", async () => {
    const queueFailure = new Error("queue observer failed");
    let queueAcquires = 0;
    await assert.rejects(admitAttempt({ model, onQueued: async () => { throw queueFailure; }, admission: {
      tryAcquire: () => undefined,
      acquire: async () => { queueAcquires += 1; return ticket(() => undefined); },
    } }), (error) => error === queueFailure);
    assert.equal(queueAcquires, 0);

    const admissionFailure = new Error("admitted observer failed");
    let releases = 0;
    await assert.rejects(admitAttempt({ model, onAdmitted: async () => { throw admissionFailure; }, admission: {
      tryAcquire: () => undefined,
      acquire: async () => ticket(() => { releases += 1; }),
    } }), (error) => error === admissionFailure);
    assert.equal(releases, 1);
  });
});

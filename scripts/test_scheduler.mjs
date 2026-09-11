import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createRequestLimiter, runCredentialWorkerPool } from "./lib/scheduler.mjs";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const worker = (number) => ({ credentialId: `credential-${number}`, slot: `key-${number}`, disabled: false, reserved: false });

// One key owns one complete lifecycle. The next row cannot start early.
{
  const gates = [deferred(), deferred()];
  const started = [];
  const run = runCredentialWorkerPool([{ task_key: "1" }, { task_key: "2" }], [worker(1)], {
    process: async (current, row) => {
      started.push({ worker: current.slot, row: row.task_key });
      await gates[Number(row.task_key) - 1].promise;
    },
  });
  await nextTurn();
  assert.deepEqual(started, [{ worker: "key-1", row: "1" }]);
  gates[0].resolve();
  await nextTurn();
  assert.deepEqual(started, [{ worker: "key-1", row: "1" }, { worker: "key-1", row: "2" }]);
  gates[1].resolve();
  assert.deepEqual(await run, { unclaimed: [] });
}

// Three keys start three tasks. The first worker to finish receives task four.
{
  const gates = Array.from({ length: 4 }, deferred);
  const started = [];
  const run = runCredentialWorkerPool(
    Array.from({ length: 4 }, (_, index) => ({ task_key: String(index + 1) })),
    [worker(1), worker(2), worker(3)],
    {
      process: async (current, row) => {
        started.push({ worker: current.slot, row: row.task_key });
        await gates[Number(row.task_key) - 1].promise;
      },
    },
  );
  await nextTurn();
  assert.deepEqual(started, [
    { worker: "key-1", row: "1" },
    { worker: "key-2", row: "2" },
    { worker: "key-3", row: "3" },
  ]);
  gates[1].resolve();
  await nextTurn();
  assert.deepEqual(started.at(-1), { worker: "key-2", row: "4" });
  gates[0].resolve();
  gates[2].resolve();
  gates[3].resolve();
  assert.deepEqual(await run, { unclaimed: [] });
}

// Pinned recovery stays with its original credential even when worker order changes.
{
  const started = [];
  await runCredentialWorkerPool([
    { task_key: "pinned", credential_id: "credential-2" },
    { task_key: "fresh" },
  ], [worker(2), worker(1)], {
    process: async (current, row) => started.push({ worker: current.slot, row: row.task_key }),
  });
  assert(started.some((entry) => entry.worker === "key-2" && entry.row === "pinned"));
}

// A definite 429 retries on the same worker before that worker claims another row.
{
  const started = [];
  let first = true;
  await runCredentialWorkerPool([{ task_key: "retry" }, { task_key: "next" }], [worker(1)], {
    process: async (current, row) => {
      started.push({ worker: current.slot, row: row.task_key });
      if (row.task_key === "retry" && first) {
        first = false;
        throw Object.assign(new Error("rate limited"), { retryQueued: true });
      }
    },
    onSettled: (_current, row, outcome) => outcome.status === "rejected" && outcome.reason.retryQueued
      ? { requeueSameWorker: true, row, handledError: true }
      : {},
  });
  assert.deepEqual(started.map((entry) => entry.row), ["retry", "retry", "next"]);
  assert(started.every((entry) => entry.worker === "key-1"));
}

// A task safely rejected by one credential wakes an already-idle healthy worker.
{
  const workers = [worker(1), worker(2)];
  const started = [];
  await runCredentialWorkerPool([{ task_key: "move" }], workers, {
    process: async (current, row) => {
      started.push(current.slot);
      if (current.slot === "key-1") throw new Error("credential rejected");
      return row.task_key;
    },
    onSettled: (current, row, outcome) => outcome.status === "rejected"
      ? { requeueFresh: true, row: { ...row, credential_id: null }, disableWorker: true, handledError: true }
      : {},
  });
  assert.deepEqual(started, ["key-1", "key-2"]);
}

// A disabled worker leaves its pinned rows unclaimed and cannot take fresh rows.
{
  const disabled = worker(1);
  disabled.disabled = true;
  const result = await runCredentialWorkerPool([
    { task_key: "pinned", credential_id: disabled.credentialId },
    { task_key: "fresh" },
  ], [disabled], { process: async () => assert.fail("disabled worker must not start") });
  assert.deepEqual(result.unclaimed.map((row) => row.task_key), ["pinned", "fresh"]);
}

// Shared request limiter remains bounded for ancillary work.
{
  let active = 0;
  let peak = 0;
  const gates = Array.from({ length: 3 }, deferred);
  const limited = createRequestLimiter(() => 2);
  const calls = gates.map((gate) => limited(async () => {
    active += 1;
    peak = Math.max(peak, active);
    try { await gate.promise; } finally { active -= 1; }
  }));
  await nextTurn();
  assert.equal(peak, 2);
  gates[0].resolve();
  gates[1].resolve();
  await nextTurn();
  gates[2].resolve();
  await Promise.all(calls);
  assert.equal(peak, 2);
}

console.log(JSON.stringify({
  ok: true,
  tests: [
    "single-key-full-lifecycle-serial",
    "three-key-parallel-and-first-free-claims-next",
    "pinned-recovery-by-credential-id",
    "429-stays-on-same-worker",
    "safe-reassignment-wakes-idle-worker",
    "disabled-worker-leaves-unclaimed",
    "request-limiter",
  ],
}));

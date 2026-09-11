// Each credential is one worker and owns at most one complete video lifecycle.
// Queue claims are synchronous, so a row can be removed by only one worker even
// though workers run concurrently between awaits.
export async function runCredentialWorkerPool(rows, workers, {
  process,
  onSettled = () => ({}),
  canClaim = () => true,
} = {}) {
  const workerIds = new Set(workers.map((worker) => worker.credentialId));
  const fresh = rows.filter((row) => !row.credential_id);
  const pinned = new Map(workers.map((worker) => [
    worker.credentialId,
    rows.filter((row) => row.credential_id === worker.credentialId),
  ]));
  const missingCredential = rows.filter((row) => row.credential_id && !workerIds.has(row.credential_id));
  let unexpected = null;

  const runWorker = async (worker) => {
    const ownQueue = pinned.get(worker.credentialId);
    while (!unexpected && !worker.disabled && !worker.reserved) {
      const row = ownQueue.shift() || (canClaim(worker, fresh[0]) ? fresh.shift() : null);
      if (!row) break;
      let outcome;
      try {
        outcome = { status: "fulfilled", value: await process(worker, row) };
      } catch (reason) {
        outcome = { status: "rejected", reason };
      }
      let directive = {};
      try {
        directive = (await onSettled(worker, row, outcome)) || {};
      } catch (error) {
        unexpected ||= error;
        break;
      }
      if (directive.requeueSameWorker) ownQueue.unshift(directive.row || row);
      if (directive.requeueFresh) fresh.push(directive.row || row);
      if (directive.disableWorker) worker.disabled = true;
      if (directive.reserveWorker) worker.reserved = true;
      if (outcome.status === "rejected" && !directive.handledError) {
        unexpected ||= outcome.reason;
        break;
      }
    }
  };

  do {
    await Promise.all(workers.filter((worker) => !worker.disabled && !worker.reserved).map(runWorker));
  } while (!unexpected && fresh.length && workers.some((worker) => !worker.disabled && !worker.reserved && canClaim(worker, fresh[0])));
  if (unexpected) throw unexpected;
  return {
    unclaimed: [
      ...missingCredential,
      ...workers.flatMap((worker) => pinned.get(worker.credentialId)),
      ...fresh,
    ],
  };
}

// Optional shared limits are retained for non-lifecycle work such as workbook
// helpers. Video workers themselves are limited by the number of credentials.
export function createRequestLimiter(getLimit) {
  const queue = [];
  let active = 0;
  const drain = () => {
    while (queue.length && active < getLimit()) {
      const { operation, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve().then(operation).then(resolve, reject).finally(() => {
        active -= 1;
        drain();
      });
    }
  };
  return (operation) => new Promise((resolve, reject) => {
    queue.push({ operation, resolve, reject });
    drain();
  });
}

const DB_NAME = "patient-oracle-live-v1";
const DB_VERSION = 1;
const JOB_STORE = "jobs";
let dbPromise = null;

export async function putLiveJob(job) {
  const db = await openDb();
  await transactionPromise(db, "readwrite", (store) => store.put(job));
  return job;
}

export async function getLiveJob(jobId) {
  const db = await openDb();
  return requestPromise(db.transaction(JOB_STORE, "readonly").objectStore(JOB_STORE).get(String(jobId)));
}

export async function listLiveJobs() {
  const db = await openDb();
  const jobs = await requestPromise(db.transaction(JOB_STORE, "readonly").objectStore(JOB_STORE).getAll());
  return jobs.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
}

export async function pruneLiveJobs({ keepTerminal = 50 } = {}) {
  const jobs = await listLiveJobs();
  const terminal = jobs.filter((job) => ["complete", "needs_user", "blocked", "failed", "cancelled", "timed_out"].includes(job.status));
  const remove = terminal.slice(Math.max(0, keepTerminal));
  if (!remove.length) return 0;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(JOB_STORE, "readwrite");
    const store = tx.objectStore(JOB_STORE);
    for (const job of remove) store.delete(job.jobId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Patient Oracle IndexedDB prune failed"));
    tx.onabort = () => reject(tx.error || new Error("Patient Oracle IndexedDB prune aborted"));
  });
  return remove.length;
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(JOB_STORE)) db.createObjectStore(JOB_STORE, { keyPath: "jobId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Patient Oracle IndexedDB open failed"));
  });
  return dbPromise;
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error || new Error("Patient Oracle IndexedDB request failed"));
  });
}

function transactionPromise(db, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(JOB_STORE, mode);
    action(tx.objectStore(JOB_STORE));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Patient Oracle IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("Patient Oracle IndexedDB transaction aborted"));
  });
}

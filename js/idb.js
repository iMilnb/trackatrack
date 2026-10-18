let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open("trackatrack", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("analysis");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

export async function idbGet(key) {
  try {
    const d = await db();
    return await new Promise((res, rej) => {
      const q = d.transaction("analysis").objectStore("analysis").get(key);
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => rej(q.error);
    });
  } catch {
    return null;
  }
}

export async function idbPut(key, val) {
  try {
    const d = await db();
    await new Promise((res, rej) => {
      const q = d.transaction("analysis", "readwrite").objectStore("analysis").put(val, key);
      q.onsuccess = res;
      q.onerror = () => rej(q.error);
    });
  } catch {
    /* non-fatal */
  }
}

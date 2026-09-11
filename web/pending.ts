export interface PendingCapture {
  id: string;
  blob: Blob;
  method: string;
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("receipt-scanner", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("pending", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("pending", mode);
      const request = operation(tx.objectStore("pending"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error ?? new Error("Local image storage failed."));
    });
  } finally {
    db.close();
  }
}

export const savePending = (capture: PendingCapture) =>
  transaction("readwrite", (store) => store.put(capture));
export const pendingCaptures = () =>
  transaction<PendingCapture[]>("readonly", (store) => store.getAll());
export const acknowledge = (id: string) =>
  transaction("readwrite", (store) => store.delete(id));

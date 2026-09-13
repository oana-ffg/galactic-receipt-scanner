export interface PendingCapture {
  id: string;
  retakeOf?: string | null;
  manual?: boolean;
  blob: Blob;
  method: string;
  quality: import("./types").Quality;
  sourcePixels: number[];
  acknowledgement?: import("./types").CaptureAcknowledgement;
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
      // The request error bubbles before the transaction's error is populated.
      tx.onerror = () =>
        reject(
          request.error ?? tx.error ?? new Error("Local image storage failed."),
        );
      tx.onabort = () =>
        reject(tx.error ?? new Error("Local image storage failed."));
    });
  } finally {
    db.close();
  }
}

export const savePending = (capture: PendingCapture) =>
  transaction("readwrite", (store) => store.put(capture));
export const retainedCaptures = () =>
  transaction<PendingCapture[]>("readonly", (store) => store.getAll());
export const pendingCaptures = async () =>
  (await retainedCaptures()).filter((capture) => !capture.acknowledgement);
export const acknowledge = (id: string) =>
  transaction("readwrite", (store) => store.delete(id));

// Edits to a score that are not saved as a copy yet, kept on this device so closing the app loses nothing.
// One draft per score (its key), the edited .mscz as bytes in IndexedDB; the opened file is never changed.
// Everything is best effort: private windows or a full disk just mean no draft.

const DB = "pocketscore.editDrafts";
const STORE = "drafts";

/** `fresh`: a score made with New score. It has no file to open again, so the start screen offers it. */
export interface EditDraft { name: string; data: ArrayBuffer; at: number; key?: string; fresh?: boolean }

function open(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
        try {
            const req = indexedDB.open(DB, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        } catch (err) {
            resolve(null);
        }
    });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
    const db = await open();
    if (!db) {
        return null;
    }
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(STORE, mode);
            const req = fn(tx.objectStore(STORE));
            tx.oncomplete = () => { db.close(); resolve(req.result ?? null); };
            tx.onerror = tx.onabort = () => { db.close(); resolve(null); };
        } catch (err) {
            db.close();
            resolve(null);
        }
    });
}

export const editDraft = {
    get: (key: string) => run<EditDraft>("readonly", (s) => s.get(key)),
    put: async (key: string, d: EditDraft) => (await run("readwrite", (s) => s.put(d, key))) !== null,
    /** Drafts of new scores, newest first. */
    fresh: async () => ((await run<EditDraft[]>("readonly", (s) => s.getAll())) ?? []).filter((d) => d.fresh).sort((a, b) => b.at - a.at),
    remove: (key: string) => run("readwrite", (s) => s.delete(key)),
};

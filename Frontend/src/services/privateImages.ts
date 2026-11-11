import { getBlob, getMetadata } from "firebase/storage";
import type { StorageReference } from "firebase/storage";
import { onAuthStateChanged } from "firebase/auth";
import auth from "../firebase/auth";
import { resolveStorageReference } from "./storageReferences";

export type PrivateImageState =
    | { status: "loading" }
    | { status: "success"; url: string }
    | { status: "error"; message: string };
type Listener = (state: PrivateImageState) => void;
type Entry = {
    key: string; uid: string; session: typeof auth.currentUser; reference: StorageReference;
    listeners: Set<Listener>; state: PrivateImageState; invalid: boolean;
    url?: string; size: number; stopAuth: () => void;
};
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVE_BYTES = 128 * 1024 * 1024;
const entries = new Map<string, Entry>();
const queue: Entry[] = [];
let running = 0;
let activeBytes = 0;
const imageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/bmp"]);
const errorState: PrivateImageState = { status: "error", message: "Não foi possível carregar a imagem. Verifique sua sessão e tente novamente." };

function emit(entry: Entry, state: PrivateImageState) {
    entry.state = state;
    for (const listener of entry.listeners) listener(state);
}
function dispose(entry: Entry) {
    entry.invalid = true;
    entry.stopAuth();
    if (entry.url) {
        URL.revokeObjectURL(entry.url);
        activeBytes -= entry.size;
        entry.url = undefined;
    }
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
}
function current(entry: Entry) {
    return !entry.invalid && entry.listeners.size > 0 && auth.currentUser === entry.session
        && auth.currentUser?.uid === entry.uid;
}
async function read(entry: Entry) {
    try {
        const metadata = await getMetadata(entry.reference);
        if (!current(entry)) return;
        if (!imageTypes.has(metadata.contentType ?? "")) {
            emit(entry, { status: "error", message: "Arquivo não disponível como imagem. Vídeos legados precisam de tratamento separado." });
            return;
        }
        const mime = metadata.contentType!;
        const expectedSize = metadata.size;
        if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_BYTES) {
            emit(entry, errorState); return;
        }
        const blob = await getBlob(entry.reference, MAX_BYTES);
        if (!current(entry)) return;
        // A nonempty, conflicting MIME must never be overwritten. Exact size
        // also prevents accepting a partial response as a complete image.
        if ((blob.type !== "" && blob.type !== mime) || blob.size !== expectedSize || blob.size > MAX_BYTES) {
            emit(entry, errorState); return;
        }
        if (expectedSize === MAX_BYTES) {
            // At the exact limit, SDK slicing can hide growth during the read.
            const latest = await getMetadata(entry.reference);
            if (!current(entry)) return;
            if (!metadata.generation || latest.generation !== metadata.generation
                || latest.size !== expectedSize || latest.contentType !== mime) {
                emit(entry, errorState); return;
            }
        }
        if (activeBytes + blob.size > MAX_ACTIVE_BYTES) { emit(entry, errorState); return; }
        // Firebase 12.16 slices bounded getBlob results without a content type.
        // Restore only that empty type, using already-authorized metadata.
        const image = blob.type === "" ? blob.slice(0, blob.size, mime) : blob;
        entry.url = URL.createObjectURL(image);
        entry.size = blob.size;
        activeBytes += blob.size;
        emit(entry, { status: "success", url: entry.url });
    } catch {
        if (current(entry)) emit(entry, errorState);
    } finally {
        if (!entry.listeners.size) dispose(entry);
    }
}
function pump() {
    while (running < 3 && queue.length) {
        const entry = queue.shift()!;
        if (!current(entry)) { dispose(entry); continue; }
        running++;
        void read(entry).finally(() => { running--; pump(); });
    }
}

/** Share active reads only. No idle cache, public URLs, tokens, or persistence. */
export function subscribePrivateImage(value: unknown, uid: string, listener: Listener): () => void {
    let reference: StorageReference;
    try { reference = resolveStorageReference(value, uid); }
    catch { listener(errorState); return () => {}; }
    const key = JSON.stringify([uid, reference.bucket, reference.fullPath]);
    let entry = entries.get(key);
    if (entry && entry.session !== auth.currentUser) {
        dispose(entry);
        emit(entry, errorState);
        entry = undefined;
    }
    const isNew = !entry;
    if (!entry) {
        entry = { key, uid, session: auth.currentUser, reference, listeners: new Set(),
            state: { status: "loading" }, invalid: false, size: 0, stopAuth: () => {} };
        entries.set(key, entry);
    }
    const owned = entry;
    owned.listeners.add(listener);
    listener(owned.state);
    if (isNew) {
        owned.stopAuth = onAuthStateChanged(auth, () => {
            if (auth.currentUser !== owned.session || auth.currentUser?.uid !== uid) {
                dispose(owned);
                emit(owned, errorState);
            }
        });
        queue.push(owned);
        pump();
    }
    return () => {
        owned.listeners.delete(listener);
        // Defer cleanup so React StrictMode can reuse a pending subscription.
        queueMicrotask(() => { if (!owned.listeners.size) dispose(owned); });
    };
}

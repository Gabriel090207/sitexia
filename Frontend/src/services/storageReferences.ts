import { ref } from "firebase/storage";
import type { StorageReference } from "firebase/storage";

import storage from "../firebase/storage";
import auth from "../firebase/auth";

/**
 * Resolve result objects only. A library entry or an old download token does not
 * prove ownership. No network request or public URL is created here; SDK reads
 * must still pass Storage Rules. Re-resolve after any account change.
 */
export function resolveStorageReference(value: unknown, expectedUid: string): StorageReference {
    const uid = auth.currentUser?.uid;
    if (!uid || uid !== expectedUid) {
        throw new Error("Entre na conta original para acessar o arquivo.");
    }

    const invalid = () => new Error("Referência de arquivo inválida ou não autorizada.");
    if (typeof value !== "string" || /[\u0000-\u0020\u007f\\]/.test(value)
        || /[/%\\\u0000-\u0020\u007f]/.test(uid) || uid === "." || uid === "..") {
        throw invalid();
    }
    // Parse the raw address: URL normalization could erase traversal evidence.
    // Legacy query parameters are deliberately discarded, never passed to ref().
    const match = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/([^/?#]+)\/o\/([^?#]+)(?:\?[^#]*)?$/.exec(value);
    if (!match) throw invalid();

    const bucket = ref(storage).bucket;
    if (match[1] !== encodeURIComponent(bucket)) throw invalid();

    let path: string;
    try {
        path = decodeURIComponent(match[2]);
    } catch {
        throw invalid();
    }
    const parts = path.split("/");
    if (parts.length < 4 || parts[0] !== "users" || parts[1] !== uid
        || !["swaps", "images", "videos"].includes(parts[2]!)
        || parts.some(part => !part || part === "." || part === "..")
        || /[%\\\u0000-\u001f\u007f]/.test(path)) {
        throw invalid();
    }
    return ref(storage, path);
}

/** Canonical object address, not a public download URL or proof of authorization. */
export function storageReferenceAddress(object: Pick<StorageReference, "bucket" | "fullPath">): string {
    return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(object.bucket)}/o/${encodeURIComponent(object.fullPath)}`;
}

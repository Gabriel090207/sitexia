import { ref, uploadBytes } from "firebase/storage";
import storage from "../firebase/storage";
import auth from "../firebase/auth";

type UploadFolder = "face-swap" | "face-swap-faces" | "video-generation";

/** New inputs only. UID scoping is not a substitute for Storage Rules. */
export async function uploadScopedFile(file: File, folder: UploadFolder, expectedUid: string | undefined): Promise<string> {
    const user = auth.currentUser;
    if (!user || !expectedUid || user.uid !== expectedUid) {
        throw new Error("Faça login para enviar arquivos.");
    }
    if (user.uid.includes("/") || !["face-swap", "face-swap-faces", "video-generation"].includes(folder)) {
        throw new Error("Caminho de upload inválido.");
    }
    // Preserve a simple extension for consumers; it does not validate file content.
    const extension = file.name.includes(".") ? file.name.split(".").pop() : undefined;
    const suffix = extension && /^[a-zA-Z0-9]{1,10}$/.test(extension) ? `.${extension}` : "";
    const object = ref(storage, `${folder}/${user.uid}/${crypto.randomUUID()}${suffix}`);
    await uploadBytes(object, file);
    // Stable object address only; the backend authorizes and signs the object.
    // This does not revoke or prove the absence of download tokens in metadata.
    return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(object.bucket)}/o/${encodeURIComponent(object.fullPath)}`;
}

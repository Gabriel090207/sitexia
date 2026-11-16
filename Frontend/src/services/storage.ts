import {
    ref,
    uploadBytes,
} from "firebase/storage";

import storage from "../firebase/storage";
import { storageReferenceAddress } from "./storageReferences";
import { MAX_GENERATED_IMAGE_BYTES, prepareGeneratedImage } from "./prepareGeneratedImage";

export async function uploadFile(
    file: File,
    folder: string
): Promise<string> {

    const extension =
        file.name.split(".").pop();

    const fileName =
        `${Date.now()}.${extension}`;

    const storageRef = ref(
        storage,
        `${folder}/${fileName}`
    );

    const snapshot = await uploadBytes(
        storageRef,
        file
    );

    return storageReferenceAddress(snapshot.ref);

}

export async function uploadImageFromUrl(
    imageUrl: string,
    folder: string
): Promise<string> {

    const response = await fetch(imageUrl);

    if (!response.ok) {
        throw new Error(
            "Não foi possível baixar a imagem gerada."
        );
    }

    const declaredSize = Number(response.headers?.get("Content-Length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_GENERATED_IMAGE_BYTES) {
        throw new Error("A imagem gerada excede o limite de 32 MB.");
    }
    let blob: Blob;
    const reader = response.body?.getReader();
    if (reader) {
        const chunks: BlobPart[] = [];
        let size = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_GENERATED_IMAGE_BYTES) {
                    await reader.cancel();
                    throw new Error("A imagem gerada excede o limite de 32 MB.");
                }
                chunks.push(new Uint8Array(value));
            }
            blob = new Blob(chunks);
        } finally {
            reader.releaseLock();
        }
    } else {
        blob = await response.blob();
    }
    const file = await prepareGeneratedImage(blob);
    const contentType = file.type;
    const extension = file.name.split(".").pop();

    const fileName =
        `${Date.now()}.${extension}`;

    const storageRef = ref(
        storage,
        `${folder}/${fileName}`
    );

    const snapshot = await uploadBytes(
        storageRef,
        file,
        {
            contentType,
        }
    );

    return storageReferenceAddress(snapshot.ref);
}

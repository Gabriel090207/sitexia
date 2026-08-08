import {
    ref,
    uploadBytes,
    getDownloadURL,
} from "firebase/storage";

import storage from "../firebase/storage";

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

    await uploadBytes(
        storageRef,
        file
    );

    return await getDownloadURL(
        storageRef
    );

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

    const blob = await response.blob();

    const contentType =
        blob.type || "image/jpeg";

    const extension =
        contentType.split("/")[1] || "jpg";

    const fileName =
        `${Date.now()}.${extension}`;

    const storageRef = ref(
        storage,
        `${folder}/${fileName}`
    );

    await uploadBytes(
        storageRef,
        blob,
        {
            contentType,
        }
    );

    return await getDownloadURL(
        storageRef
    );
}
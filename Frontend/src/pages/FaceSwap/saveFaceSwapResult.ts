import { uploadFile } from "../../services/storage";

export type FaceSwapMediaType = "image" | "video";
const formats: Record<string, { mediaType: FaceSwapMediaType; extension: string }> = {
    "image/jpeg": { mediaType: "image", extension: "jpg" },
    "image/png": { mediaType: "image", extension: "png" },
    "image/webp": { mediaType: "image", extension: "webp" },
    "image/gif": { mediaType: "image", extension: "gif" },
    "image/avif": { mediaType: "image", extension: "avif" },
    "image/bmp": { mediaType: "image", extension: "bmp" },
    "video/mp4": { mediaType: "video", extension: "mp4" },
    "video/webm": { mediaType: "video", extension: "webm" },
    "video/quicktime": { mediaType: "video", extension: "mov" },
    "video/ogg": { mediaType: "video", extension: "ogv" },
    "video/x-m4v": { mediaType: "video", extension: "m4v" },
    "video/x-matroska": { mediaType: "video", extension: "mkv" },
    "video/x-msvideo": { mediaType: "video", extension: "avi" },
    "video/avi": { mediaType: "video", extension: "avi" },
    "video/mpeg": { mediaType: "video", extension: "mpg" },
    "video/x-ms-wmv": { mediaType: "video", extension: "wmv" },
};

/** One provider download, then the existing generic File upload. No task creation. */
export async function saveFaceSwapResult(url: string, uid: string, expected: FaceSwapMediaType | "unknown") {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Não foi possível baixar o resultado concluído.");
    const blob = await response.blob();
    const mime = blob.type.split(";", 1)[0]!.trim().toLowerCase();
    const format = formats[mime];
    if (!format || blob.size === 0 || (expected !== "unknown" && format.mediaType !== expected)) {
        throw new Error("O conteúdo recebido não corresponde a um resultado de mídia válido.");
    }
    const file = new File([blob], `face-swap-result.${format.extension}`, { type: mime });
    const reference = await uploadFile(file, `users/${uid}/swaps`);
    return { reference, mediaType: format.mediaType };
}

export const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 64_000_000;

function identify(bytes: Uint8Array): [string, string] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = (offset: number, length: number) => String.fromCharCode(...bytes.slice(offset, offset + length));
    const invalid = () => new Error("O conteúdo recebido não corresponde a uma imagem válida e suportada.");
    const size = bytes.length;
    if (size >= 5 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        && bytes[size - 2] === 255 && bytes[size - 1] === 217) return ["image/jpeg", "jpg"];
    if (size >= 33 && [137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value)) {
        let offset = 8;
        if (text(12, 4) !== "IHDR" || view.getUint32(8) !== 13) throw invalid();
        while (offset + 12 <= size) {
            const length = view.getUint32(offset);
            const type = text(offset + 4, 4);
            if (length > size - offset - 12) throw invalid();
            offset += length + 12;
            if (type === "IEND") {
                if (length !== 0 || offset !== size) throw invalid();
                return ["image/png", "png"];
            }
        }
        throw invalid();
    }
    if (size >= 20 && text(0, 4) === "RIFF" && text(8, 4) === "WEBP"
        && view.getUint32(4, true) + 8 === size && ["VP8 ", "VP8L", "VP8X"].includes(text(12, 4))) {
        return ["image/webp", "webp"];
    }
    if (size >= 14 && ["GIF87a", "GIF89a"].includes(text(0, 6)) && bytes[size - 1] === 59) return ["image/gif", "gif"];
    if (size >= 26 && text(0, 2) === "BM" && view.getUint32(2, true) === size
        && view.getUint32(10, true) >= 26 && view.getUint32(10, true) < size) return ["image/bmp", "bmp"];
    if (size >= 16 && text(4, 4) === "ftyp") {
        const boxSize = view.getUint32(0);
        if (boxSize >= 16 && boxSize <= size && boxSize % 4 === 0) {
            const brands = [text(8, 4)];
            for (let offset = 16; offset < boxSize; offset += 4) brands.push(text(offset, 4));
            if (brands.some(brand => brand === "avif" || brand === "avis")) return ["image/avif", "avif"];
        }
    }
    throw invalid();
}

async function decodeImage(blob: Blob): Promise<void> {
    const valid = (width: number, height: number) => Number.isSafeInteger(width) && Number.isSafeInteger(height)
        && width > 0 && height > 0 && width * height <= MAX_PIXELS;
    const error = () => new Error("A imagem recebida está inválida, incompleta ou excede as dimensões permitidas.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (typeof createImageBitmap === "function") {
        let expired = false;
        try {
            await Promise.race([
                createImageBitmap(blob).then(bitmap => {
                    try { if (!valid(bitmap.width, bitmap.height)) throw error(); }
                    finally { bitmap.close(); }
                    if (expired) throw error();
                }),
                new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(error()); }, 20_000); }),
            ]);
        } catch { throw error(); }
        finally { clearTimeout(timer); }
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const image = new Image();
        const url = URL.createObjectURL(blob);
        const finish = (success: boolean) => {
            clearTimeout(timer);
            image.onload = null; image.onerror = null;
            image.removeAttribute("src"); URL.revokeObjectURL(url);
            if (success) resolve(); else reject(error());
        };
        image.onload = () => finish(valid(image.naturalWidth, image.naturalHeight));
        image.onerror = () => finish(false);
        timer = setTimeout(() => finish(false), 20_000);
        image.src = url;
    });
}

/** Signature + complete browser decode. Never infer format from HTTP MIME/name. */
export async function prepareGeneratedImage(blob: Blob): Promise<File> {
    if (!blob.size || blob.size > MAX_GENERATED_IMAGE_BYTES) throw new Error("Tamanho da imagem gerada inválido ou acima do limite de 32 MB.");
    const [mime, extension] = identify(new Uint8Array(await blob.arrayBuffer()));
    const file = new File([blob], `generated-image.${extension}`, { type: mime });
    await decodeImage(file);
    return file;
}

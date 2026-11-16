const videoFormats: Record<string, string> = {
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "video/ogg": "ogv", "video/x-m4v": "m4v", "video/x-matroska": "mkv",
    "video/x-msvideo": "avi", "video/avi": "avi", "video/mpeg": "mpg", "video/x-ms-wmv": "wmv",
};

async function hasMp4Brand(blob: Blob): Promise<boolean> {
    const bytes = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
    if (bytes.length < 16) return false;
    const view = new DataView(bytes.buffer);
    const size = view.getUint32(0);
    const text = (offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));
    if (text(4) !== "ftyp" || size < 16 || size > bytes.length || size % 4 !== 0) return false;
    const brands = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "M4V ", "MSNV"]);
    if (brands.has(text(8))) return true;
    for (let offset = 16; offset < size; offset += 4) {
        if (brands.has(text(offset))) return true;
    }
    return false;
}

/** Let the browser demux and load a video frame, not merely trust a file header. */
function validateVideo(blob: Blob): Promise<void> {
    return new Promise((resolve, reject) => {
        const video = document.createElement("video");
        const url = URL.createObjectURL(blob);
        const finish = (valid: boolean) => {
            clearTimeout(timer);
            video.onloadeddata = null;
            video.onerror = null;
            video.pause();
            video.removeAttribute("src");
            video.load();
            URL.revokeObjectURL(url);
            if (valid) resolve();
            else reject(new Error("O conteúdo recebido não é um vídeo válido ou compatível com este navegador."));
        };
        const timer = setTimeout(() => finish(false), 20000);
        video.onloadeddata = () => finish(video.videoWidth > 0 && video.videoHeight > 0
            && Number.isFinite(video.duration) && video.duration > 0);
        video.onerror = () => finish(false);
        video.preload = "auto";
        video.muted = true;
        video.src = url;
        video.load();
    });
}

/** Shared video preparation; no Storage, task creation or financial calls. */
export async function prepareVideoFile(blob: Blob): Promise<File> {
    if (blob.size === 0) throw new Error("O vídeo recebido está vazio.");
    let mime = blob.type.split(";", 1)[0]!.trim().toLowerCase();
    if (mime === "" || mime === "application/octet-stream" || mime === "video/mp4") {
        if (!await hasMp4Brand(blob)) throw new Error("O conteúdo recebido não corresponde a um vídeo MP4 válido.");
        mime = "video/mp4";
    }
    const extension = videoFormats[mime];
    if (!extension) throw new Error("O formato do vídeo recebido não é suportado.");
    const file = new File([blob], `video-${Date.now()}.${extension}`, { type: mime });
    await validateVideo(file);
    return file;
}

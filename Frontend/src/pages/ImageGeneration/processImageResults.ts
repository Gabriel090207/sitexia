type ImageResultServices = {
    upload: (url: string, folder: string) => Promise<string>;
    register: (userId: string, url: string, type: "image-generation") => Promise<unknown>;
    onSaved: (url: string) => void;
};

export async function processImageResults(
    imageUrls: unknown,
    userId: string,
    batchId: string,
    services: ImageResultServices,
) {
    if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
        throw new Error("A API não retornou a imagem gerada.");
    }
    // Validate the entire response before starting any downloads.
    const urls = imageUrls.map((value: unknown) => {
        if (typeof value !== "string") {
            throw new Error("A API retornou uma URL de imagem inválida.");
        }
        try {
            const url = new URL(value);
            if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
                throw new Error();
            }
        } catch {
            throw new Error("A API retornou uma URL de imagem inválida.");
        }
        return value;
    });

    let uploadFailures = 0;
    let libraryFailures = 0;
    for (const [index, url] of urls.entries()) {
        let savedUrl: string;
        try {
            // Separate folders prevent collisions in the timestamp-based upload helper.
            savedUrl = await services.upload(url, `users/${userId}/images/${batchId}/${index}`);
        } catch {
            uploadFailures++;
            continue;
        }
        services.onSaved(savedUrl);
        try {
            await services.register(userId, savedUrl, "image-generation");
        } catch {
            libraryFailures++;
        }
    }
    return { total: urls.length, uploadFailures, libraryFailures };
}

const API_URL =
    import.meta.env.VITE_API_URL;


export async function createImageToVideo(
    imageUrl: string,
    prompt: string,
    duration: number,
    userId: string
) {

    const response = await fetch(
        `${API_URL}/video-generation/image-to-video`,
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json",
            },

            body: JSON.stringify({
                image_url: imageUrl,
                prompt,
                duration,
                user_id: userId,
            }),
        }
    );

    if (!response.ok) {

        throw new Error(
            "Erro ao criar geração de vídeo."
        );

    }

    return await response.json();
}


export async function getVideoTask(
    taskId: string
) {

    const response = await fetch(
        `${API_URL}/video-generation/task/${taskId}`
    );

    if (!response.ok) {

        throw new Error(
            "Erro ao consultar geração de vídeo."
        );

    }

    return await response.json();
}


export async function createVideoExtend(
    sourceTaskId: string,
    prompt: string,
    duration: number,
    userId: string
) {

    const response = await fetch(
        `${API_URL}/video-generation/extend`,
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json",
            },

            body: JSON.stringify({
                source_task_id: sourceTaskId,
                prompt,
                duration,
                user_id: userId,
            }),
        }
    );

    if (!response.ok) {

        throw new Error(
            "Erro ao criar extensão do vídeo."
        );

    }

    return await response.json();
}


export async function createReferenceToVideo(
    referenceUrl: string,
    prompt: string,
    duration: number,
    userId: string
) {

    const response = await fetch(
        `${API_URL}/video-generation/reference-to-video`,
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json",
            },

            body: JSON.stringify({
                reference_url: referenceUrl,
                prompt,
                duration,
                user_id: userId,
            }),
        }
    );

    if (!response.ok) {

        throw new Error(
            "Erro ao criar vídeo de referência."
        );

    }

    return await response.json();
}


export async function createTextToVideo(
    prompt: string,
    referenceImageUrl: string,
    duration: number,
    userId: string
) {

    const response = await fetch(
        `${API_URL}/video-generation/text-to-video`,
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json",
            },

            body: JSON.stringify({
                prompt,
                reference_image_url: referenceImageUrl,
                duration,
                user_id: userId,
            }),
        }
    );

    if (!response.ok) {

        throw new Error(
            "Erro ao criar vídeo a partir do texto."
        );

    }

    return await response.json();
}
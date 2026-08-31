import api from "./api";


export async function createImageToVideo(
    imageUrl: string,
    prompt: string,
    duration: number
) {
    const response = await api.post(
        "/video-generation/image-to-video",
        {
            image_url: imageUrl,
            prompt,
            duration,
        }
    );
    return response.data;
}


export async function getVideoTask(
    taskId: string
) {
    const response = await api.get(
        `/video-generation/task/${taskId}`
    );
    return response.data;
}


export async function createVideoExtend(
    sourceTaskId: string,
    prompt: string,
    duration: number
) {
    const response = await api.post(
        "/video-generation/extend",
        {
            source_task_id: sourceTaskId,
            prompt,
            duration,
        }
    );
    return response.data;
}


export async function createReferenceToVideo(
    referenceUrl: string,
    prompt: string,
    duration: number
) {
    const response = await api.post(
        "/video-generation/reference-to-video",
        {
            reference_url: referenceUrl,
            prompt,
            duration,
        }
    );
    return response.data;
}


export async function createTextToVideo(
    prompt: string,
    referenceImageUrl: string,
    duration: number
) {
    const response = await api.post(
        "/video-generation/text-to-video",
        {
            prompt,
            reference_image_url: referenceImageUrl,
            duration,
        }
    );
    return response.data;
}

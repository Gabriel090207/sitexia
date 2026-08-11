import api from "./api";

export async function createMaterial(
    imageUrl: string
) {
    const { data } = await api.post(
        "/swap/material",
        {
            image_url: imageUrl
        }
    );

    return data;
}

export async function createSwapTask(
    materialId: string,
    sourceFaceId: string,
    targetFaceUrl: string,
    userId: string,
    generationCost: number
) {
    const { data } = await api.post(
        "/swap/task",
        {
            material_id: materialId,
            source_face_id: sourceFaceId,
            target_face_url: targetFaceUrl,
            user_id: userId,
            generation_cost: generationCost
        }
    );

    return data;
}

export async function getMaterial(
    materialId: string
) {
    const { data } = await api.get(
        `/swap/material/${materialId}`
    );

    return data;
}

export async function getSwapTask(
    taskId: string
) {
    const { data } = await api.get(
        `/swap/task/${taskId}`
    );

    return data;
}

export async function getSwapResult(
    taskId: string
) {
    const { data } = await api.post(
        "/swap/result",
        {
            task_id: taskId
        }
    );

    return data;
}
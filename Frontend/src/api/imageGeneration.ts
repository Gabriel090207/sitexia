import api from "./api";


export async function createTextToImage(
    prompt: string,
    style: string,
    quantity: number
) {
    const response = await api.post(
        "/image-generation/text-to-image",
        {
            prompt,
            style,
            quantity,
        }
    );
    return response.data;
}


export async function getImageTask(
    taskId: string
) {
    const response = await api.get(
        `/image-generation/task/${taskId}`
    );
    return response.data;
}

const API_URL =
    import.meta.env.VITE_API_URL;


export async function createTextToImage(
    prompt: string,
    style: string,
    quantity: number,
    userId: string
) {

    const response = await fetch(
        `${API_URL}/image-generation/text-to-image`,
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json",
            },

            body: JSON.stringify({
                prompt,
                style,
                quantity,
                user_id: userId,
            }),
        }
    );

    if (!response.ok) {

        const errorData = await response
            .json()
            .catch(() => null);

        throw new Error(
            errorData?.detail ||
            "Erro ao criar a geração de imagem."
        );

    }

    return await response.json();
}


export async function getImageTask(
    taskId: string
) {

    const response = await fetch(
        `${API_URL}/image-generation/task/${taskId}`
    );

    if (!response.ok) {

        const errorData = await response
            .json()
            .catch(() => null);

        throw new Error(
            errorData?.detail ||
            "Erro ao consultar a geração de imagem."
        );

    }

    return await response.json();
}
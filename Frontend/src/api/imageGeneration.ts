const API_URL =
    import.meta.env.VITE_API_URL;


export async function createTextToImage(
    prompt: string
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
            }),
        }
    );

    if (!response.ok) {

        throw new Error(
            "Erro ao criar a geração de imagem."
        );

    }

    return response.json();
}


export async function getImageTask(
    taskId: string
) {

    const response = await fetch(
        `${API_URL}/image-generation/task/${taskId}`
    );

    if (!response.ok) {

        throw new Error(
            "Erro ao consultar a geração de imagem."
        );

    }

    return response.json();
}
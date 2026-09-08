import { isAxiosError } from "axios";

const networkMessage =
    "Não foi possível conectar ao serviço. Verifique sua conexão e tente novamente.";
const timeoutMessage =
    "A geração demorou mais do que o esperado. Tente novamente.";

const knownExternalErrors = [
    {
        fragment: "no face detected in the input image",
        publicMessage: "Nenhum rosto foi detectado na imagem enviada.",
    },
] as const;

function getKnownExternalMessage(message: unknown): string | undefined {
    if (typeof message !== "string") {
        return undefined;
    }
    const normalizedMessage = message.toLowerCase();
    return knownExternalErrors.find((rule) =>
        normalizedMessage.includes(rule.fragment)
    )?.publicMessage;
}

const httpMessages: Readonly<Record<number, string>> = {
    400: "Os dados enviados para a geração são inválidos. Verifique as informações e tente novamente.",
    401: "Sua sessão expirou. Entre novamente para continuar.",
    402: "Você não possui créditos suficientes para realizar esta geração.",
    403: "Você não tem permissão para realizar esta operação.",
    404: "Não foi possível encontrar o recurso necessário para a geração.",
    422: "Os dados enviados para a geração são inválidos. Verifique as informações e tente novamente.",
    429: "Muitas solicitações foram realizadas. Aguarde um momento e tente novamente.",
    500: "Não foi possível concluir a geração devido a um erro interno. Tente novamente.",
    502: "O serviço de geração está temporariamente indisponível. Tente novamente em alguns instantes.",
    503: "O serviço de geração está temporariamente indisponível. Tente novamente em alguns instantes.",
};

// Somente textos exatos controlados pela aplicação podem ser reutilizados.
const safeDetails = new Set([
    "Duração inválida.",
    "Quantidade de imagens inválida.",
    "Prompt obrigatório.",
    "Estilo de imagem inválido.",
    "Usuário não encontrado.",
    "Duração do vídeo inválida.",
    "Tipo de mídia inválido.",
]);

const detailTranslations = new Map([
    ["Credencial de autenticação inválida.", httpMessages[401]],
    ["Créditos insuficientes.", httpMessages[402]],
]);

const safeLocalMessages = new Set([
    "A geração do vídeo falhou.",
    "A geração da imagem falhou.",
    "Não foi possível baixar o vídeo gerado.",
    "Não foi possível baixar a imagem gerada.",
    "A geração terminou sem retornar o vídeo.",
    "A API não retornou a imagem gerada.",
    "Não foi possível identificar a duração do vídeo.",
]);

export function getGenerationErrorMessage(
    error: unknown,
    fallback: string
): string {
    if (error instanceof Error) {
        const knownMessage = getKnownExternalMessage(error.message);
        if (knownMessage) {
            return knownMessage;
        }
    }

    const axiosError = isAxiosError<unknown>(error) ? error : undefined;
    const data = axiosError?.response?.data;
    const detail =
        typeof data === "object" && data !== null && "detail" in data
            ? data.detail
            : undefined;
    const knownDetail = getKnownExternalMessage(detail);
    if (knownDetail) {
        return knownDetail;
    }
    if (typeof detail === "string") {
        const translatedDetail = detailTranslations.get(detail);
        if (translatedDetail) {
            return translatedDetail;
        }
        if (safeDetails.has(detail)) {
            return detail;
        }
    }

    const code =
        typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined;
    if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
        return timeoutMessage;
    }
    if (
        code === "ERR_NETWORK" ||
        code === "auth/network-request-failed" ||
        axiosError?.message === "Network Error"
    ) {
        return networkMessage;
    }
    if (error instanceof Error) {
        if (error.name === "TimeoutError") {
            return timeoutMessage;
        }
        if (
            error instanceof TypeError &&
            ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"]
                .includes(error.message)
        ) {
            return networkMessage;
        }
    }

    const status = axiosError?.response?.status;
    if (status !== undefined && httpMessages[status]) {
        return httpMessages[status];
    }

    if (error instanceof Error) {
        if (error.message === "Usuário não autenticado.") {
            return "Entre na sua conta para continuar.";
        }
        if (safeLocalMessages.has(error.message)) {
            return error.message;
        }
    }

    return fallback;
}

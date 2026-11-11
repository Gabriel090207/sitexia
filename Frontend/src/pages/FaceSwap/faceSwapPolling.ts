export class FaceSwapFlowError extends Error {}

export function requireSwapId(value: unknown): string {
    if (typeof value !== "string" || !/^[0-9]*[1-9][0-9]*$/.test(value)) {
        throw new FaceSwapFlowError("O serviço retornou um identificador inválido para o Face Swap.");
    }
    return value;
}

export function requireResultUrl(value: unknown): string {
    try {
        if (typeof value !== "string") throw new Error();
        const url = new URL(value);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
        return value;
    } catch {
        throw new FaceSwapFlowError("O serviço concluiu o Face Swap sem retornar uma URL de resultado válida.");
    }
}

// UNKNOWN is documented, but is not evidence of either success or failure.
// Stop local observation without changing the provider task or its billing.
export async function waitForFaceSwap(
    fetchStatus: () => Promise<unknown>,
    field: "status" | "taskStatus",
    label: string,
    timeoutMs = 10 * 60 * 1000,
    intervalMs = 2000,
): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    const timeout = () => new FaceSwapFlowError(
        `O limite de espera para ${label} foi atingido. O processamento pode continuar no serviço. Nenhuma nova tarefa foi criada automaticamente.`,
    );
    while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw timeout();
        await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
        const requestTime = deadline - Date.now();
        if (requestTime <= 0) throw timeout();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let response: unknown;
        try {
            response = await Promise.race([
                fetchStatus(),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeout()), requestTime); }),
            ]);
        } finally {
            clearTimeout(timer);
        }
        if (!response || typeof response !== "object" || Array.isArray(response)) {
            throw new FaceSwapFlowError(`O serviço retornou uma resposta inválida durante ${label}.`);
        }
        const data = response as Record<string, unknown>;
        switch (data[field]) {
            case "SUCCEEDED": return data;
            case "FAILED": throw new FaceSwapFlowError(`Falha durante ${label}.`);
            case "PENDING":
            case "RUNNING": break;
            case "UNKNOWN": throw new FaceSwapFlowError(`O serviço não conseguiu informar o estado durante ${label}. O resultado não foi confirmado; nenhuma nova tarefa foi criada automaticamente.`);
            default: throw new FaceSwapFlowError(`O serviço retornou um estado inesperado durante ${label}.`);
        }
    }
}

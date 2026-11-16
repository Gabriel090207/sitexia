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

export function isTransientTaskError(error: unknown): boolean {
    const failure = error as { response?: { status?: number; data?: { detail?: unknown } }; code?: string; name?: string; message?: string } | null;
    if (failure?.response) {
        const detail = failure.response.data?.detail;
        if (typeof detail === "string" && /inválid|incompatível|inconsistente|incompleto|não autorizad|não encontrad/i.test(detail)) return false;
        return [502, 503, 504].includes(failure.response.status ?? 0);
    }
    return ["ECONNABORTED", "ETIMEDOUT", "ERR_NETWORK"].includes(failure?.code ?? "")
        || failure?.name === "TimeoutError"
        || (failure?.name === "TypeError" && ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"].includes(failure.message ?? ""));
}

// UNKNOWN is documented, but is not evidence of either success or failure.
// Stop local observation without changing the provider task or its billing.
export async function waitForFaceSwap(
    fetchStatus: (signal?: AbortSignal) => Promise<unknown>,
    field: "status" | "taskStatus",
    label: string,
    timeoutMs = 10 * 60 * 1000,
    intervalMs = 2000,
    options: { signal?: AbortSignal; isCurrent?: () => boolean } = {},
): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const cancelled = () => new FaceSwapFlowError("O acompanhamento do Face Swap foi interrompido. A tarefa pode continuar e os créditos podem permanecer reservados. Não inicie outra geração para substituí-la.");
    const unconfirmed = () => new FaceSwapFlowError(
        field === "status"
            ? `O limite de espera para ${label} foi atingido. O processamento pode continuar no serviço. Nenhuma nova tarefa foi criada automaticamente.`
            : `Não foi possível confirmar o andamento do Face Swap (limite de espera ou de falhas durante ${label}). A tarefa pode continuar em processamento e os créditos podem permanecer reservados. Não inicie outra geração para substituir esta tentativa.`,
    );
    const check = () => {
        if (options.signal?.aborted || options.isCurrent?.() === false) throw cancelled();
        if (Date.now() >= deadline) throw unconfirmed();
    };
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
        check();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: () => void = () => {};
        try {
            return await Promise.race([
                new Promise<never>((_, reject) => {
                    onAbort = () => reject(cancelled());
                    controller.signal.addEventListener("abort", onAbort, { once: true });
                    timer = setTimeout(() => { reject(unconfirmed()); controller.abort(); }, Math.max(0, deadline - Date.now()));
                }),
                operation(),
            ]);
        } finally {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", onAbort);
        }
    };
    let failures = 0;
    let delay = intervalMs;
    try {
        while (true) {
            let waitTimer: ReturnType<typeof setTimeout> | undefined;
            try {
                await bounded(() => new Promise<void>(resolve => { waitTimer = setTimeout(resolve, delay); }));
            } finally {
                clearTimeout(waitTimer);
            }
            check();
            let response: unknown;
            try {
                response = await bounded(() => fetchStatus(controller.signal));
                check();
            } catch (error) {
                check();
                // Material analysis and task creation never receive retries here.
                if (field !== "taskStatus" || !isTransientTaskError(error)) throw error;
                failures++;
                if (failures >= 3) throw unconfirmed();
                delay = Math.min(8000, Math.max(intervalMs, 2000) * 2 ** failures);
                continue;
            }
            if (!response || typeof response !== "object" || Array.isArray(response)) {
                throw new FaceSwapFlowError(`O serviço retornou uma resposta inválida durante ${label}.`);
            }
            const data = response as Record<string, unknown>;
            failures = 0;
            delay = intervalMs;
            switch (data[field]) {
                case "SUCCEEDED": return data;
                case "FAILED": throw new FaceSwapFlowError(`Falha durante ${label}.`);
                case "PENDING":
                case "RUNNING": break;
                case "UNKNOWN": throw new FaceSwapFlowError(`O serviço não conseguiu informar o estado durante ${label}. O resultado não foi confirmado; nenhuma nova tarefa foi criada automaticamente.`);
                default: throw new FaceSwapFlowError(`O serviço retornou um estado inesperado durante ${label}.`);
            }
        }
    } finally {
        options.signal?.removeEventListener("abort", abort);
        controller.abort();
    }
}

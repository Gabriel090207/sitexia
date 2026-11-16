import { FaceSwapFlowError, isTransientTaskError, requireResultUrl, requireSwapId } from "./faceSwapPolling";

function canRetryResult(error: unknown): boolean {
    if (!isTransientTaskError(error)) return false;
    const response = (error as { response?: { status?: number; data?: { detail?: unknown } } }).response;
    // Known backend 502 validation failures must not be retried as outages.
    if (response?.status === 502) {
        const detail = response.data?.detail;
        return detail === undefined || detail === "Não foi possível consultar o resultado na Deep."
            || detail === "Não foi possível confirmar o estado financeiro na Deep.";
    }
    return true;
}

/** Resolve only the existing task. Upload and library writes stay with the caller. */
export async function resolveFaceSwapResult(
    taskId: string,
    fetchResult: (taskId: string, signal: AbortSignal) => Promise<unknown>,
    options: { signal?: AbortSignal; isCurrent?: () => boolean; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
    requireSwapId(taskId);
    const controller = new AbortController();
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    const unavailable = () => new FaceSwapFlowError("Não foi possível obter o resultado do Face Swap neste momento. A tarefa pode ter sido concluída e os créditos podem ter sido cobrados. Não inicie outra geração para substituir esta tentativa.");
    const cancelled = () => new FaceSwapFlowError("A obtenção do resultado do Face Swap foi interrompida. A tarefa pode ter sido concluída e os créditos podem ter sido cobrados. Não inicie outra geração para substituir esta tentativa.");
    const check = () => {
        if (options.signal?.aborted || options.isCurrent?.() === false) throw cancelled();
        if (Date.now() >= deadline) throw unavailable();
    };
    const abort = () => controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
        check();
        const stopped = new Promise<never>((_, reject) => {
            onAbort = () => reject(cancelled());
            controller.signal.addEventListener("abort", onAbort, { once: true });
            timer = setTimeout(() => { reject(unavailable()); controller.abort(); }, Math.max(0, deadline - Date.now()));
        });
        const resolve = async () => {
            for (let attempt = 0; attempt < 3; attempt++) {
                check();
                let response: unknown;
                try {
                    response = await fetchResult(taskId, controller.signal);
                } catch (error) {
                    check();
                    if (controller.signal.aborted) throw cancelled();
                    if (!canRetryResult(error)) throw error;
                    if (attempt === 2) throw unavailable();
                    await new Promise<void>(done => { waitTimer = setTimeout(done, attempt === 0 ? 4000 : 8000); });
                    continue;
                }
                check();
                if (controller.signal.aborted) throw cancelled();
                if (!response || typeof response !== "object" || Array.isArray(response)) {
                    throw new FaceSwapFlowError("O serviço retornou um resultado inválido para o Face Swap.");
                }
                const result = response as Record<string, unknown>;
                if (result.success === false || (result.status !== undefined && result.status !== "SUCCEEDED")) {
                    throw new FaceSwapFlowError("O serviço retornou um estado de resultado inválido para o Face Swap.");
                }
                if (result.task_id !== undefined && requireSwapId(result.task_id) !== taskId) {
                    throw new FaceSwapFlowError("O serviço retornou um resultado de outra tarefa Face Swap.");
                }
                requireResultUrl(result.file_url);
                return result;
            }
            throw unavailable();
        };
        return await Promise.race([stopped, resolve()]);
    } finally {
        clearTimeout(timer);
        clearTimeout(waitTimer);
        options.signal?.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", onAbort);
        controller.abort();
    }
}

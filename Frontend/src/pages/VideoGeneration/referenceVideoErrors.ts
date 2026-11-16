/** Local R2V presentation only; never infer a credit movement from task status. */
export class ReferenceVideoFailedError extends Error {
    constructor() {
        super("A geração do vídeo não foi concluída pelo provedor. Nenhum vídeo foi produzido nesta tentativa.");
    }
}

export function getReferenceVideoErrorMessage(error: unknown): string | undefined {
    const response = (error as { response?: { status?: number; data?: { detail?: unknown } } } | null)?.response;
    const detail = response?.data?.detail;
    if (response?.status === 503 && detail && typeof detail === "object"
        && "code" in detail && detail.code === "financial_finalization_unconfirmed") {
        return "Não foi possível confirmar a finalização desta geração. O estado dos créditos pode estar pendente. Não inicie outra geração para substituir esta tentativa.";
    }
    if (error instanceof ReferenceVideoFailedError) return error.message;
    return undefined;
}

import { FaceSwapFlowError, requireSwapId, waitForFaceSwap } from "./faceSwapPolling";

export type SwapIntent = {
    key: string;
    original: string;
    target: string;
    mediaType: "image" | "gif" | "video";
    duration: number | null;
};
export type SwapInputs = Pick<SwapIntent, "original" | "target" | "mediaType" | "duration">;

// Firebase object URLs without download tokens are sufficient for /swap/task:
// the backend verifies the object and signs its own version-bound download URL.
export function objectAddress(value: string): string {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "firebasestorage.googleapis.com" || url.port
        || url.username || url.password || !/^\/v0\/b\/[^/]+\/o\/.+/.test(url.pathname)) {
        throw new FaceSwapFlowError("O arquivo precisa ser enviado pelo upload do Face Swap.");
    }
    return `${url.origin}${url.pathname}`;
}

export function createIntent(inputs: SwapInputs): SwapIntent {
    return { ...inputs, original: objectAddress(inputs.original), target: objectAddress(inputs.target),
        key: crypto.randomUUID() };
}

type Services = {
    createMaterial: (url: string) => Promise<{ materialId?: unknown }>;
    getMaterial: (id: string) => Promise<unknown>;
    createSwapTask: (material: string, face: string, target: string, type: SwapIntent["mediaType"], duration: number | null, key: string) => Promise<{ taskId?: unknown }>;
    wait?: typeof waitForFaceSwap;
};

export async function startSwapTask(intent: SwapIntent, originalUrl: string, services: Services): Promise<string> {
    const wait = services.wait ?? waitForFaceSwap;
    const created = await services.createMaterial(originalUrl);
    const materialId = requireSwapId(created?.materialId);
    const material = await wait(() => services.getMaterial(materialId), "status", "a análise do material");
    if (requireSwapId(material.materialId) !== materialId) {
        throw new FaceSwapFlowError("O serviço retornou um material diferente do solicitado.");
    }
    if (!Array.isArray(material.faces)) throw new FaceSwapFlowError("O serviço retornou dados de rostos inválidos.");
    if (!material.faces.length) throw new FaceSwapFlowError("Nenhum rosto foi detectado no arquivo enviado.");
    const face = material.faces.find((item: unknown) => {
        if (!item || typeof item !== "object" || !("id" in item)) return false;
        try { requireSwapId(item.id); return true; } catch { return false; }
    });
    if (!face) throw new FaceSwapFlowError("O serviço não retornou nenhum rosto válido para a substituição.");
    const sourceFaceId = requireSwapId(face.id);
    // One submission per active generation, without automatic retries.
    const task = await services.createSwapTask(materialId, sourceFaceId, intent.target,
        intent.mediaType, intent.duration, intent.key);
    return requireSwapId(task?.taskId);
}

export function swapOperationError(error: unknown): string | undefined {
    const response = (error as { response?: { status?: number; data?: { detail?: unknown } } } | null)?.response;
    const detail = response?.data?.detail;
    const code = detail && typeof detail === "object" && "code" in detail ? detail.code : undefined;
    if (response?.status === 409) {
        return ["operation_pending", "operation_pending_or_cancelled"].includes(String(code))
            ? "A operação continua sem confirmação ou foi cancelada antes do envio. O backend não confirmou devolução de créditos."
            : "A operação foi recusada por conflito de intenção ou estado; nenhuma nova tarefa foi criada automaticamente.";
    }
    if (response?.status === 422) return "O backend rejeitou os dados ou a chave de idempotência. Não haverá reenvio automático.";
    if (code === "submission_unconfirmed" || response?.status === 503) return "Não foi possível confirmar a operação. A reserva pode continuar ativa. Não crie outra operação para substituí-la.";
    return undefined;
}

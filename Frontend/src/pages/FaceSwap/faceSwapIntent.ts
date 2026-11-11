import { FaceSwapFlowError, requireSwapId, waitForFaceSwap } from "./faceSwapPolling";

export type SwapIntent = {
    key: string;
    original: string;
    target: string;
    mediaType: "image" | "gif" | "video";
    duration: number | null;
    phase: "new" | "material-requested" | "material-ready" | "task-requested" | "task-known";
    materialId?: string;
    sourceFaceId?: string;
    taskId?: string;
    saved?: boolean;
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

export function selectIntent(intents: SwapIntent[], inputs: SwapInputs): SwapIntent {
    const clean = { ...inputs, original: objectAddress(inputs.original), target: objectAddress(inputs.target) };
    const found = intents.find(item => item.original === clean.original && item.target === clean.target
        && item.mediaType === clean.mediaType && item.duration === clean.duration);
    return found ?? { ...clean, key: crypto.randomUUID(), phase: "new" };
}

const storageKey = (uid: string) => `xia:face-swap:intents:v1:${uid}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function loadIntents(storage: Storage, uid: string): SwapIntent[] {
    try {
        const value: unknown = JSON.parse(storage.getItem(storageKey(uid)) ?? "[]");
        if (!Array.isArray(value) || value.length > 20) throw new Error();
        return value.map(item => {
            if (!item || typeof item !== "object" || !uuid.test(item.key)
                || !["image", "gif", "video"].includes(item.mediaType)
                || !["new", "material-requested", "material-ready", "task-requested", "task-known"].includes(item.phase)
                || (item.duration !== null && (typeof item.duration !== "number" || !Number.isFinite(item.duration) || item.duration <= 0))) throw new Error();
            const clean: SwapIntent = { key: item.key, original: objectAddress(item.original), target: objectAddress(item.target),
                mediaType: item.mediaType, duration: item.duration, phase: item.phase };
            for (const field of ["materialId", "sourceFaceId", "taskId"] as const) {
                if (item[field] !== undefined) clean[field] = requireSwapId(item[field]);
            }
            if ((clean.sourceFaceId && !clean.materialId)
                || (["material-ready", "task-requested"].includes(clean.phase) && (!clean.materialId || !clean.sourceFaceId))
                || (clean.phase === "task-known" && !clean.taskId)) throw new Error();
            if (item.saved === true) clean.saved = true;
            return clean;
        });
    } catch {
        throw new FaceSwapFlowError("Não foi possível ler as operações preservadas nesta sessão.");
    }
}

export function storeIntent(storage: Storage, uid: string, intents: SwapIntent[], intent: SwapIntent): SwapIntent[] {
    const next = [...intents.filter(item => item.key !== intent.key), { ...intent }];
    // Keep all unresolved attempts. Only completed local records may be evicted.
    while (next.length > 20) {
        const completed = next.findIndex(item => item.saved);
        if (completed < 0) throw new FaceSwapFlowError("Há muitas operações pendentes nesta sessão. Recupere as anteriores antes de iniciar outra.");
        next.splice(completed, 1);
    }
    try { storage.setItem(storageKey(uid), JSON.stringify(next)); }
    catch { throw new FaceSwapFlowError("Não foi possível preservar a operação nesta sessão. Nenhum novo envio será iniciado."); }
    return next;
}

type Services = {
    createMaterial: (url: string) => Promise<{ materialId?: unknown }>;
    getMaterial: (id: string) => Promise<unknown>;
    createSwapTask: (material: string, face: string, target: string, type: SwapIntent["mediaType"], duration: number | null, key: string) => Promise<{ taskId?: unknown }>;
    wait?: typeof waitForFaceSwap;
};

export async function recoverSwapTask(intent: SwapIntent, originalUrl: string | undefined,
    remember: (intent: SwapIntent) => void, services: Services): Promise<string> {
    const wait = services.wait ?? waitForFaceSwap;
    if (intent.taskId) return requireSwapId(intent.taskId);
    if (!intent.materialId) {
        if (intent.phase !== "new" || !originalUrl) {
            throw new FaceSwapFlowError("A criação do material ficou sem confirmação. Nenhum material ou tarefa será recriado automaticamente. A operação precisa de análise.");
        }
        intent.phase = "material-requested";
        remember(intent); // Persist BEFORE any possible external side effect.
        const material = await services.createMaterial(originalUrl);
        intent.materialId = requireSwapId(material?.materialId);
        remember(intent);
    }
    if (!intent.sourceFaceId) {
        const material = await wait(() => services.getMaterial(intent.materialId!), "status", "a análise do material");
        if (requireSwapId(material.materialId) !== intent.materialId) {
            throw new FaceSwapFlowError("O serviço retornou um material diferente do solicitado.");
        }
        if (!Array.isArray(material.faces)) throw new FaceSwapFlowError("O serviço retornou dados de rostos inválidos.");
        if (!material.faces.length) throw new FaceSwapFlowError("Nenhum rosto foi detectado no arquivo enviado.");
        const face = material.faces.find((item: unknown) => {
            if (!item || typeof item !== "object" || !("id" in item)) return false;
            try { requireSwapId(item.id); return true; } catch { return false; }
        });
        if (!face) throw new FaceSwapFlowError("O serviço não retornou nenhum rosto válido para a substituição.");
        intent.sourceFaceId = requireSwapId(face.id);
        intent.phase = "material-ready";
        remember(intent);
    }
    intent.phase = "task-requested";
    remember(intent);
    // Called only by an explicit user action. No automatic retry on any error.
    const task = await services.createSwapTask(intent.materialId, intent.sourceFaceId, intent.target,
        intent.mediaType, intent.duration, intent.key);
    intent.taskId = requireSwapId(task?.taskId);
    intent.phase = "task-known";
    remember(intent);
    return intent.taskId;
}

export function swapOperationError(error: unknown): string | undefined {
    const response = (error as { response?: { status?: number; data?: { detail?: unknown } } } | null)?.response;
    const detail = response?.data?.detail;
    const code = detail && typeof detail === "object" && "code" in detail ? detail.code : undefined;
    if (response?.status === 409) {
        return ["operation_pending", "operation_pending_or_cancelled"].includes(String(code))
            ? "A operação continua sem confirmação ou foi cancelada antes do envio. O backend não confirmou devolução de créditos. Preserve esta operação para análise ou recuperação manual."
            : "A recuperação foi recusada por conflito de intenção ou estado. Preserve a chave existente; nenhuma nova tarefa foi criada automaticamente.";
    }
    if (response?.status === 422) return "O backend rejeitou os dados ou a chave de idempotência. A operação foi preservada; não será reenviada automaticamente.";
    if (code === "submission_unconfirmed" || response?.status === 503) return "Não foi possível confirmar a operação. A reserva pode continuar ativa. Use a recuperação manual da mesma operação; não crie outra para substituí-la.";
    return undefined;
}

import { onAuthStateChanged } from "firebase/auth";
import auth from "../firebase/auth";
import api from "../api/api";

export type VideoPlaybackState = { status: "idle" | "loading" | "ready" | "error"; message?: string };
type Snapshot = { time: number; volume: number; muted: boolean; rate: number };

/** One player, one in-flight request. Signed URLs never leave this session. */
export function createPrivateVideoPlayback(video: HTMLVideoElement, itemId: string, uid: string,
    notify: (state: VideoPlaybackState) => void) {
    const session = auth.currentUser;
    let disposed = false;
    let stopped = false;
    let expiresAt = 0;
    let access = false;
    let replacing = false;
    let wanted = false;
    let renewedAfterError = false;
    let pending: Snapshot | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: Promise<void> | null = null;
    let controller: AbortController | null = null;
    const current = () => !disposed && !stopped && !!session && auth.currentUser === session && session.uid === uid;
    const emit = (state: VideoPlaybackState) => { if (!disposed) notify(state); };
    const expired = () => Date.now() >= expiresAt - 5000;
    const capture = (): Snapshot => ({ time: video.currentTime || 0, volume: video.volume,
        muted: video.muted, rate: video.playbackRate });
    function cancelTimer() { clearTimeout(timer); timer = undefined; }
    function clearSource() {
        cancelTimer();
        replacing = true;
        video.pause(); video.removeAttribute("src"); video.load();
        replacing = false;
        access = false;
    }
    function fail(message: string) {
        pending ??= capture();
        clearSource();
        emit({ status: "error", message });
    }
    function schedule() {
        cancelTimer();
        if (current() && access && !video.paused) {
            timer = setTimeout(() => { void acquire(); }, Math.max(0, expiresAt - Date.now() - 5000));
        }
    }
    async function resume() {
        if (!current()) return;
        try { await video.play(); }
        catch { if (current()) emit({ status: "error", message: "O navegador não iniciou o vídeo. Toque em reproduzir para tentar novamente." }); }
    }
    function message(error: unknown) {
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status === 401) return "Sua sessão expirou. Entre novamente para assistir.";
        if (status === 403) return "Você não tem permissão para acessar este vídeo.";
        if (status === 404) return "O vídeo não foi encontrado.";
        if (status === 415) return "O arquivo não possui um formato de vídeo compatível.";
        return "Não foi possível obter acesso ao vídeo. Tente novamente.";
    }
    function acquire(): Promise<void> {
        if (!current()) return Promise.resolve();
        if (request) return request;
        pending ??= capture();
        controller = new AbortController();
        const signal = controller.signal;
        emit({ status: "loading" });
        request = (async () => {
            try {
                const { data } = await api.post(`/media/${encodeURIComponent(itemId)}/video-access`, undefined,
                    { signal, timeout: 15000 });
                if (!current() || signal.aborted) return;
                const parsed = new URL(data.url);
                const absolute = Date.parse(data.expiresAt);
                if (data.mediaType !== "video" || typeof data.contentType !== "string" || !data.contentType.startsWith("video/")
                    || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash
                    || !(parsed.hostname === "storage.googleapis.com" || parsed.hostname.endsWith(".storage.googleapis.com"))
                    || parsed.port || parsed.searchParams.has("token") || !parsed.searchParams.get("X-Goog-Signature")
                    || !Number.isFinite(absolute) || !Number.isFinite(data.expiresInSeconds) || data.expiresInSeconds <= 0) {
                    throw new Error("Invalid video access response");
                }
                expiresAt = Math.min(absolute, Date.now() + Math.min(data.expiresInSeconds, 1800) * 1000);
                if (expired()) throw new Error("Expired video access response");
                replacing = true;
                video.pause();
                access = true;
                video.src = parsed.href;
                video.load();
                // pause/load events are asynchronous: keep the restore guard until metadata arrives.
            } catch (error) {
                if (current() && !signal.aborted) fail(message(error));
            } finally { request = null; controller = null; }
        })();
        return request;
    }
    function loaded() {
        if (!current() || !access) return;
        replacing = false;
        if (pending) {
            try {
                video.volume = pending.volume; video.muted = pending.muted; video.playbackRate = pending.rate;
                video.currentTime = Number.isFinite(video.duration) ? Math.min(pending.time, video.duration) : pending.time;
                pending = null;
            } catch {
                fail("O navegador não conseguiu restaurar a posição do vídeo. Tente reproduzir novamente.");
                return;
            }
        }
        renewedAfterError = false;
        emit({ status: "ready" });
        if (wanted) void resume();
    }
    function played() {
        if (!current()) { clearSource(); return; }
        wanted = true;
        if (expired()) { void acquire(); return; }
        schedule();
    }
    function paused() { if (!replacing) wanted = false; cancelTimer(); }
    function check() { if (current() && access && expired() && !request) void acquire(); }
    function visible() { if (document.visibilityState === "visible" && (wanted || !video.paused)) check(); }
    function failed() {
        if (!current() || request || !access) return;
        if (expired() && !renewedAfterError) { renewedAfterError = true; void acquire(); }
        else fail("Não foi possível reproduzir o vídeo. O formato, a conexão ou o acesso podem estar indisponíveis.");
    }
    const events = { loadedmetadata: loaded, play: played, pause: paused, seeking: check, error: failed };
    for (const [name, listener] of Object.entries(events)) video.addEventListener(name, listener);
    document.addEventListener("visibilitychange", visible);
    const stopAuth = onAuthStateChanged(auth, () => {
        if (!current() && !disposed) {
            stopped = true; controller?.abort(); clearSource(); pending = null;
            emit({ status: "error", message: "A sessão mudou. Entre na conta original para assistir." });
        }
    });
    return {
        async play() {
            if (!current()) { emit({ status: "error", message: "Entre na conta original para assistir." }); return; }
            wanted = true;
            if (access && !expired()) await resume(); else await acquire();
        },
        dispose() {
            disposed = true; controller?.abort(); stopAuth(); cancelTimer();
            for (const [name, listener] of Object.entries(events)) video.removeEventListener(name, listener);
            document.removeEventListener("visibilitychange", visible);
            clearSource(); pending = null;
        },
    };
}

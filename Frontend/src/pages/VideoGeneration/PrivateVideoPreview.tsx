import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import auth from "../../firebase/auth";
import { createPrivateVideoPlayback } from "../../services/privateVideoPlayback";
import { queueVideoPreview } from "./videoPreviewQueue";

/** Decorative paused frame inside a selection button; no nested controls. */
export default function PrivateVideoPreview({ itemId, uid }: { itemId: string; uid: string }) {
    const video = useRef<HTMLVideoElement>(null);
    const [status, setStatus] = useState<"waiting" | "loading" | "ready" | "error">("waiting");
    useEffect(() => {
        const element = video.current;
        if (!element) return;
        const session = auth.currentUser;
        let disposed = false;
        let requested = false;
        let visible = false;
        let settled = false;
        let cancel: (() => void) | undefined;
        let player: ReturnType<typeof createPrivateVideoPlayback> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let complete: (() => void) | undefined;
        const current = () => !disposed && !!session && auth.currentUser === session && session.uid === uid;
        const finish = (success: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            element.pause();
            element.preload = "none";
            if (current()) setStatus(success ? "ready" : "error");
            if (!success) player?.dispose();
            complete?.();
        };
        const loaded = () => finish(element.videoWidth > 0 && element.videoHeight > 0);
        const failed = () => finish(false);
        element.addEventListener("loadeddata", loaded);
        element.addEventListener("error", failed);
        const request = () => {
            if (requested || !current()) return;
            requested = true;
            setStatus("loading");
            cancel = queueVideoPreview(done => {
                complete = done;
                if (!current() || !visible) {
                    requested = false;
                    if (current()) setStatus("waiting");
                    done();
                    return;
                }
                timer = setTimeout(failed, 20000);
                player = createPrivateVideoPlayback(element, itemId, uid, state => {
                    if (state.status === "error") failed();
                });
                element.preload = "auto";
                void player.prepare(); // Never play: loadeddata supplies a paused frame.
            });
        };
        const root = element.closest(".video-generation-selector-grid");
        let observer: IntersectionObserver | undefined;
        const checkVisible = () => {
            const rect = element.getBoundingClientRect();
            const bounds = root?.getBoundingClientRect();
            visible = rect.width > 0 && rect.height > 0 && rect.bottom > Math.max(0, bounds?.top ?? 0)
                && rect.top < Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight)
                && rect.right > 0 && rect.left < window.innerWidth;
            if (visible) request();
        };
        if (typeof IntersectionObserver !== "undefined") {
            observer = new IntersectionObserver(entries => {
                visible = entries.some(entry => entry.isIntersecting);
                if (visible) request();
            }, { root });
            observer.observe(element);
        } else {
            checkVisible();
            root?.addEventListener("scroll", checkVisible);
            window.addEventListener("resize", checkVisible);
        }
        const stopAuth = onAuthStateChanged(auth, () => {
            if (!current()) {
                clearTimeout(timer);
                player?.dispose();
                cancel?.();
                if (!disposed) setStatus("error");
            }
        });
        return () => {
            disposed = true;
            observer?.disconnect();
            root?.removeEventListener("scroll", checkVisible);
            window.removeEventListener("resize", checkVisible);
            stopAuth();
            clearTimeout(timer);
            element.removeEventListener("loadeddata", loaded);
            element.removeEventListener("error", failed);
            player?.dispose();
            cancel?.();
        };
    }, [itemId, uid]);
    return <span className="video-generation-video-preview" aria-hidden="true">
        <video ref={video} muted playsInline preload="none" tabIndex={-1} />
        {status !== "ready" && <span className="video-generation-preview-placeholder">
            {status === "error" ? "Prévia indisponível" : status === "loading" ? "Carregando prévia…" : "Prévia do vídeo"}
        </span>}
    </span>;
}

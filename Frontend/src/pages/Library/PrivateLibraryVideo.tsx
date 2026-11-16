import "./PrivateLibraryVideo.css";
import { useEffect, useRef, useState } from "react";
import { createPrivateVideoPlayback } from "../../services/privateVideoPlayback";
import type { VideoPlaybackState } from "../../services/privateVideoPlayback";

export default function PrivateLibraryVideo({ itemId, uid }: { itemId: string; uid: string }) {
    const video = useRef<HTMLVideoElement>(null);
    const playback = useRef<ReturnType<typeof createPrivateVideoPlayback> | null>(null);
    const [state, setState] = useState<VideoPlaybackState>({ status: "idle" });
    useEffect(() => {
        if (!video.current) return;
        setState({ status: "idle" });
        const player = createPrivateVideoPlayback(video.current, itemId, uid, setState);
        playback.current = player;
        const element = video.current;
        let observer: IntersectionObserver | undefined;
        let wasVisible = false;
        const checkVisible = () => {
            const bounds = element.getBoundingClientRect();
            const visible = bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0
                && bounds.top < window.innerHeight && bounds.left < window.innerWidth;
            if (visible && !wasVisible) void player.prepare();
            wasVisible = visible;
        };
        if (typeof IntersectionObserver !== "undefined") {
            observer = new IntersectionObserver(entries => {
                if (entries.some(entry => entry.isIntersecting)) void player.prepare();
            });
            observer.observe(element);
        } else {
            checkVisible();
            window.addEventListener("scroll", checkVisible, true);
            window.addEventListener("resize", checkVisible);
        }
        return () => {
            observer?.disconnect();
            window.removeEventListener("scroll", checkVisible, true);
            window.removeEventListener("resize", checkVisible);
            playback.current = null;
            player.dispose();
        };
    }, [itemId, uid]);
    return (
        <div className="library-video-player">
            <video ref={video} controls playsInline preload="none" className="library-item-video" />
            {(state.status === "loading" || state.status === "error") && (
                <div className="library-private-video-status">
                    {state.message && <p role="alert">{state.message}</p>}
                    {state.status === "loading" ? <span role="status">Preparando vídeo…</span> : (
                        <button type="button" onClick={() => { void playback.current?.prepare(); }}>
                            Tentar carregar novamente
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

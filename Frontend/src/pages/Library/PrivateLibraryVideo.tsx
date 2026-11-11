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
        return () => { playback.current = null; player.dispose(); };
    }, [itemId, uid]);
    return (
        <div className="library-video-player">
            <video ref={video} controls playsInline preload="none" className="library-item-video" />
            {state.status !== "ready" && (
                <div className="library-private-video-status">
                    {state.message && <p role="alert">{state.message}</p>}
                    {state.status === "loading" ? <span role="status">Preparando vídeo…</span> : (
                        <button type="button" onClick={() => { void playback.current?.play(); }}>
                            {state.status === "error" ? "Tentar reproduzir novamente" : "Reproduzir vídeo"}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

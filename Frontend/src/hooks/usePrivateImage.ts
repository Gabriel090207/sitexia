import { useEffect, useState } from "react";
import auth from "../firebase/auth";
import { subscribePrivateImage } from "../services/privateImages";
import type { PrivateImageState } from "../services/privateImages";

export function usePrivateImage(value: string, uid: string, enabled: boolean): PrivateImageState {
    const key = JSON.stringify([uid, value]);
    const [result, setResult] = useState<{ key: string; state: PrivateImageState } | null>(null);
    useEffect(() => {
        if (!enabled) return;
        let active = true;
        const stop = subscribePrivateImage(value, uid, state => {
            if (active) setResult({ key, state });
        });
        return () => { active = false; stop(); };
    }, [key, value, uid, enabled]);
    if (!enabled || auth.currentUser?.uid !== uid || result?.key !== key) return { status: "loading" };
    return result.state;
}

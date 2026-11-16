import { useLayoutEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { scrollPageToTop } from "../utils/scrollLock";

function ScrollToTop() {
    const { pathname, hash } = useLocation();
    const previousPath = useRef<string | null>(null);

    useLayoutEffect(() => {
        const previous = window.history.scrollRestoration;
        window.history.scrollRestoration = "manual";
        return () => { window.history.scrollRestoration = previous; };
    }, []);

    useLayoutEffect(() => {
        if (previousPath.current === pathname) return;
        previousPath.current = pathname;
        // Leave fragment navigation to the existing anchor behavior.
        if (!hash) scrollPageToTop();
    }, [pathname, hash]);

    return null;
}

export default ScrollToTop;

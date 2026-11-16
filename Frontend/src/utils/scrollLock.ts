let locks = 0;
let restore: (() => void) | undefined;
let resetLockedPosition: (() => void) | undefined;

/** Route navigation must also replace a pending overlay scroll restoration. */
export function scrollPageToTop(): void {
    resetLockedPosition?.();
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
}

/** Independent overlays share one lock and restore only after the last closes. */
export function lockPageScroll(): () => void {
    if (locks === 0) {
        const body = document.body;
        const root = document.documentElement;
        let x = window.scrollX;
        let y = window.scrollY;
        const gap = Math.max(0, window.innerWidth - root.clientWidth);
        const padding = parseFloat(window.getComputedStyle(body).paddingRight) || 0;
        const properties = ["position", "top", "left", "width", "overflow", "padding-right", "box-sizing", "overscroll-behavior"];
        const save = (style: CSSStyleDeclaration, names: string[]) => {
            const values = names.map(name => [name, style.getPropertyValue(name), style.getPropertyPriority(name)]);
            return () => {
                for (const [name, value, priority] of values) {
                    if (value) style.setProperty(name!, value, priority);
                    else style.removeProperty(name!);
                }
            };
        };
        const restoreBody = save(body.style, properties);
        const restoreRoot = save(root.style, ["overflow", "overscroll-behavior"]);
        const restoreBehavior = save(root.style, ["scroll-behavior"]);
        body.style.setProperty("position", "fixed");
        body.style.setProperty("top", `${-y}px`);
        body.style.setProperty("left", `${-x}px`);
        body.style.setProperty("width", "100%");
        body.style.setProperty("box-sizing", "border-box");
        body.style.setProperty("overflow", "hidden");
        body.style.setProperty("overscroll-behavior", "none");
        if (gap) body.style.setProperty("padding-right", `${padding + gap}px`);
        root.style.setProperty("overflow", "hidden");
        root.style.setProperty("overscroll-behavior", "none");
        resetLockedPosition = () => {
            x = 0;
            y = 0;
            body.style.setProperty("top", "0px");
            body.style.setProperty("left", "0px");
        };
        restore = () => {
            restoreBody();
            restoreRoot();
            root.style.setProperty("scroll-behavior", "auto", "important");
            window.scrollTo(x, y);
            restoreBehavior();
        };
    }
    locks++;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (--locks === 0) {
            restore?.();
            restore = undefined;
            resetLockedPosition = undefined;
        }
    };
}

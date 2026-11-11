import { useEffect, useRef, useState } from "react";
import { usePrivateImage } from "../../hooks/usePrivateImage";

export default function PrivateLibraryImage({ value, uid, alt }: { value: string; uid: string; alt: string }) {
    const container = useRef<HTMLDivElement>(null);
    const [visible, setVisible] = useState(false);
    const [failedUrl, setFailedUrl] = useState("");
    useEffect(() => {
        if (!container.current) return;
        if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
        const observer = new IntersectionObserver(entries => {
            setVisible(entries.some(entry => entry.isIntersecting));
        }, { rootMargin: "200px" });
        observer.observe(container.current);
        return () => observer.disconnect();
    }, []);
    const image = usePrivateImage(value, uid, visible);
    const decodeError = image.status === "success" && failedUrl === image.url;
    return (
        <div ref={container} className="library-private-image">
            {image.status === "success" && !decodeError ? (
                <img src={image.url} alt={alt} className="library-item-image"
                    onError={() => setFailedUrl(image.url)} />
            ) : image.status === "error" || decodeError ? (
                <span role="alert">{image.status === "error" ? image.message : "Não foi possível exibir esta imagem."}</span>
            ) : (
                <span role="status">{visible ? "Carregando imagem…" : "Imagem aguardando visualização"}</span>
            )}
        </div>
    );
}

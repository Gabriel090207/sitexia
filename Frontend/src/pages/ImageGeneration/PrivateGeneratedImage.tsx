import { useEffect, useRef, useState } from "react";
import { usePrivateImage } from "../../hooks/usePrivateImage";

export default function PrivateGeneratedImage({ value, uid, index }: { value: string; uid: string; index: number }) {
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
        <div ref={container} className="image-generation-private-result">
            {image.status === "success" && !decodeError ? (
                <img src={image.url} alt={`Imagem gerada ${index + 1}`}
                    className="image-generation-result-image" onError={() => setFailedUrl(image.url)} />
            ) : image.status === "error" || decodeError ? (
                <p role="alert">
                    Imagem {index + 1} salva, mas não foi possível exibi-la.
                    {" "}{image.status === "error" ? image.message : "Falha ao abrir a imagem."}
                    {" "}O arquivo salvo foi preservado; não é necessário gerar novamente.
                </p>
            ) : (
                <p role="status">{visible ? `Carregando imagem ${index + 1}…` : `Imagem ${index + 1} aguardando visualização`}</p>
            )}
        </div>
    );
}

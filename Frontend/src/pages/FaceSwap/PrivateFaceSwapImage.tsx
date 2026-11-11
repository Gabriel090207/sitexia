import { useEffect, useState } from "react";
import { usePrivateImage } from "../../hooks/usePrivateImage";

export default function PrivateFaceSwapImage({ value, uid, onUrlChange }: {
    value: string; uid: string; onUrlChange: (url: string) => void;
}) {
    const image = usePrivateImage(value, uid, true);
    const [failedUrl, setFailedUrl] = useState("");
    const url = image.status === "success" && image.url !== failedUrl ? image.url : "";
    useEffect(() => {
        onUrlChange(url);
        return () => onUrlChange("");
    }, [url, onUrlChange]);
    if (url) return <img src={url} alt="Resultado" className="face-swap-generation-image"
        onError={() => setFailedUrl(url)} />;
    if (image.status === "error" || (image.status === "success" && failedUrl === image.url)) return (
        <p role="alert">O Face Swap foi concluído e o arquivo foi salvo, mas não foi possível exibir a imagem.
            {" "}{image.status === "error" ? image.message : "Falha ao abrir a imagem."}
            {" "}A referência foi preservada; não é necessário gerar novamente.</p>
    );
    return <p role="status">Carregando a imagem salva…</p>;
}

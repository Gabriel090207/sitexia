import "./Library.css";
import PrivateLibraryImage from "./PrivateLibraryImage";
import PrivateLibraryVideo from "./PrivateLibraryVideo";
import api from "../../api/api";
import auth from "../../firebase/auth";

import {
    useEffect,
    useState,
} from "react";

import { useAuth } from "../../contexts/AuthContext";

import {
    subscribeToLibrary,
    isLibraryVideo,
    type LibraryItem,
} from "../../services/library";

import {
    LayoutGrid,
    ScanFace,
    Image as ImageIcon,
    Video,
    Download,
    LoaderCircle,
} from "lucide-react";

export default function Library() {

const { user } = useAuth();

const [items, setItems] =
    useState<LibraryItem[]>([]);

const [downloadError, setDownloadError] = useState("");

const [downloadingId, setDownloadingId] =
    useState<string | null>(null);

type LibraryFilter =
    | "all"
    | "face-swap"
    | "image-generation"
    | "video-generation";

const [activeFilter, setActiveFilter] =
    useState<LibraryFilter>("all");

async function handleDownload(item: LibraryItem) {

    const session = auth.currentUser;
    if (!user || downloadingId || !session || session.uid !== user.uid) {
        return;
    }

    try {

        setDownloadingId(item.id);
        setDownloadError("");

        const response = await api.get<Blob>(
            `/download/${encodeURIComponent(user.uid)}/${encodeURIComponent(item.id)}`,
            { responseType: "blob", params: { delivery: "direct" } }
        );

        if (auth.currentUser !== session) return;
        const blob = response.data;
        if ((response.headers["content-type"] as string | undefined)?.startsWith("application/json")) {
            const access = JSON.parse(await blob.text());
            const url = new URL(access.url);
            if (url.protocol !== "https:" || url.username || url.password || url.hash
                || !(url.hostname === "storage.googleapis.com" || url.hostname.endsWith(".storage.googleapis.com"))
                || url.port || url.searchParams.has("token") || !url.searchParams.get("X-Goog-Signature")
                || access.mediaType !== "video" || typeof access.contentType !== "string" || !access.contentType.startsWith("video/")
                || typeof access.filename !== "string" || !/^xia-(face-swap|video-generation)-[0-9-]+\.[a-z0-9]+$/.test(access.filename)
                || !Number.isFinite(Date.parse(access.expiresAt)) || Date.parse(access.expiresAt) <= Date.now()) {
                throw new Error("Acesso de download inválido.");
            }
            if (auth.currentUser !== session) return;
            const link = document.createElement("a");
            link.href = url.href;
            link.download = access.filename;
            link.rel = "noreferrer noopener";
            link.referrerPolicy = "no-referrer";
            document.body.appendChild(link);
            link.click();
            link.remove();
            return;
        }
        const contentDisposition = response.headers["content-disposition"] as string | undefined;

        let filename =
            item.type === "video-generation"
                ? "xia-video-generation.mp4"
                : "xia-image.png";

        if (contentDisposition) {

            const match = contentDisposition.match(
                /filename="?([^";]+)"?/
            );

            if (match?.[1]) {

                filename = match[1].trim();

            }

        }

        const objectUrl =
            URL.createObjectURL(blob);

        const link =
            document.createElement("a");

        link.href = objectUrl;

        link.download = filename;

        document.body.appendChild(link);

        link.click();

        link.remove();

        URL.revokeObjectURL(objectUrl);

    } catch {

        setDownloadError("Não foi possível iniciar o download. Verifique sua sessão e tente novamente.");

    } finally {

        setDownloadingId(null);

    }

}

const filteredItems = items.filter((item) => {

    if (activeFilter === "all") {
        return true;
    }

    if (activeFilter === "video-generation") return isLibraryVideo(item);
    return item.type === activeFilter;

});

useEffect(() => {

    if (!user) {

        setItems([]);

        return;

    }

    const unsubscribe =
        subscribeToLibrary(
            user.uid,
            (libraryItems) => {

                setItems(libraryItems);

            }
        );

    return () => {

        unsubscribe();

    };

}, [user]);

    return (

        <main className="library">

            <div className="library-container">

                <header className="library-header">

                    <h1 className="library-title">

                        Minha <span>Biblioteca</span>

                    </h1>

                    <p className="library-description">

                        Visualize e gerencie todas as suas criações geradas com a Xia.

                    </p>

                </header>

                <section className="library-filters">

                    <button
                        type="button"
                        className={`library-filter ${
                            activeFilter === "all"
                                ? "library-filter-active"
                                : ""
                        }`}
                        onClick={() => setActiveFilter("all")}
                    >
                        <LayoutGrid size={19} />

                        <span>
                            Todos
                        </span>
                    </button>

                    <button
                        type="button"
                        className={`library-filter ${
                            activeFilter === "face-swap"
                                ? "library-filter-active"
                                : ""
                        }`}
                        onClick={() => setActiveFilter("face-swap")}
                    >
                        <ScanFace size={19} />

                        <span>
                            Face Swap
                        </span>
                    </button>

                    <button
                        type="button"
                        className={`library-filter ${
                            activeFilter === "image-generation"
                                ? "library-filter-active"
                                : ""
                        }`}
                        onClick={() => setActiveFilter("image-generation")}
                    >
                        <ImageIcon size={19} />

                        <span>
                            Imagens
                        </span>
                    </button>

                    <button
                        type="button"
                        className={`library-filter ${
                            activeFilter === "video-generation"
                                ? "library-filter-active"
                                : ""
                        }`}
                        onClick={() => setActiveFilter("video-generation")}
                    >
                        <Video size={19} />

                        <span>
                            Vídeos
                        </span>
                    </button>

                </section>


                {downloadError && <p role="alert">{downloadError}</p>}
                <section className="library-content">

                    {filteredItems.length > 0 ? (

                        <div className="library-grid">

                            {filteredItems.map((item) => (

                                <article
                                    key={item.id}
                                    className="library-item"
                                >

                                    <div className="library-item-preview">

                                        {isLibraryVideo(item) ? (

                                            item.videoUrl ? (

                                                <PrivateLibraryVideo
                                                    key={`${user?.uid ?? ""}:${item.id}`}
                                                    itemId={item.id}
                                                    uid={user?.uid ?? ""}
                                                />

                                            ) : null

                                        ) : (

                                            item.imageUrl ? (

                                                <PrivateLibraryImage
                                                    value={item.imageUrl}
                                                    uid={user?.uid ?? ""}
                                                    alt={item.type === "face-swap" ? "Face Swap gerado" : "Imagem gerada"}
                                                />

                                            ) : null

                                        )}

                                    </div>

                                    <div className="library-item-info">

                                        <div className="library-item-details">

                                            <strong>

                                                {item.type === "face-swap"
                                                    ? "Face Swap"
                                                    : item.type === "video-generation"
                                                        ? "Video Generation"
                                                        : "Image Generation"}

                                            </strong>

                                            <span>

                                                {isLibraryVideo(item)
                                                    ? "Vídeo gerado"
                                                    : "Imagem gerada"}

                                            </span>

                                        </div>

                                        <button
                                            type="button"
                                            className="library-item-download"
                                            onClick={() => handleDownload(item)}
                                            disabled={
                                                downloadingId === item.id ||
                                                (
                                                    isLibraryVideo(item)
                                                        ? !item.videoUrl
                                                        : !item.imageUrl
                                                )
                                            }
                                            aria-label={
                                                downloadingId === item.id
                                                    ? "Baixando arquivo"
                                                    : isLibraryVideo(item)
                                                        ? "Baixar vídeo"
                                                        : "Baixar imagem"
                                            }
                                        >

                                            {downloadingId === item.id ? (

                                                <LoaderCircle
                                                    size={18}
                                                    className="library-item-download-spinner"
                                                />

                                            ) : (

                                                <Download size={18} />

                                            )}

                                        </button>

                                    </div>

                                </article>

                            ))}

                        </div>

                    ) : (

                        <div className="library-empty">

                            <div className="library-empty-icon">

                                <ImageIcon size={34} />

                            </div>

                            <h2>
                                Nenhum arquivo encontrado
                            </h2>

                            <p>
                                Você ainda não possui arquivos nesta categoria.
                            </p>

                        </div>

                    )}

                </section>

            </div>

        </main>

    );

}
import "./Library.css";

import {
    useEffect,
    useRef,
    useState,
} from "react";

import { useAuth } from "../../contexts/AuthContext";

import {
    subscribeToLibrary,
    type LibraryItem,
} from "../../services/library";

import {
    LayoutGrid,
    ScanFace,
    Image as ImageIcon,
    Video,
    Download,
    Play,
    Pause,
    LoaderCircle,
} from "lucide-react";

function LibraryVideoPlayer({
    src,
}: {
    src: string;
}) {

    const videoRef = useRef<HTMLVideoElement | null>(null);

    const [isPlaying, setIsPlaying] = useState(false);

    const [currentTime, setCurrentTime] = useState(0);

    const [duration, setDuration] = useState(0);

    function togglePlay() {

        const video = videoRef.current;

        if (!video) {
            return;
        }

       if (video.paused) {

            void video.play().catch(() => {
                setIsPlaying(false);
            });

        } else {

            video.pause();

        }

    }

    return (

        <div className="library-video-player">

            <video
                ref={videoRef}
                src={src}
                className="library-item-video"
                preload="metadata"
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onTimeUpdate={(event) =>
                    setCurrentTime(event.currentTarget.currentTime)
                }
                onLoadedMetadata={(event) => {

                    const videoDuration =
                        event.currentTarget.duration;

                    setDuration(
                        Number.isFinite(videoDuration)
                            ? videoDuration
                            : 0
                    );

                }}
                onEnded={(event) => {

                    event.currentTarget.currentTime = 0;

                    setCurrentTime(0);
                    setIsPlaying(false);

                }}
            />

            <div className="library-video-controls">

                <button
                    type="button"
                    className="library-video-play"
                    onClick={togglePlay}
                    aria-label={
                        isPlaying
                            ? "Pausar vídeo"
                            : "Reproduzir vídeo"
                    }
                >

                    {isPlaying
                        ? <Pause size={18} />
                        : <Play size={18} />
                    }

                </button>

                <input
                    type="range"
                    className="library-video-progress"
                    min="0"
                    max={duration || 0}
                    step="0.1"
                    value={currentTime}
                    onChange={(event) => {

                        const video = videoRef.current;

                        if (!video) {
                            return;
                        }

                        const newTime =
                            Number(event.target.value);

                        video.currentTime = newTime;

                        setCurrentTime(newTime);

                    }}
                />

            </div>

        </div>

    );

}

export default function Library() {

const { user } = useAuth();

const [items, setItems] =
    useState<LibraryItem[]>([]);

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

    if (!user || downloadingId) {
        return;
    }

    try {

        setDownloadingId(item.id);

        const apiUrl = import.meta.env.VITE_API_URL;

        const downloadUrl =
            `${apiUrl}/download/${user.uid}/${item.id}`;

        const response = await fetch(downloadUrl);

        if (!response.ok) {
            throw new Error("Não foi possível baixar o arquivo.");
        }

        const blob = await response.blob();

        const contentDisposition =
            response.headers.get("Content-Disposition");

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

        // O feedback visual será tratado pelo sistema de toast.

    } finally {

        setDownloadingId(null);

    }

}

const filteredItems = items.filter((item) => {

    if (activeFilter === "all") {
        return true;
    }

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


                <section className="library-content">

                    {filteredItems.length > 0 ? (

                        <div className="library-grid">

                            {filteredItems.map((item) => (

                                <article
                                    key={item.id}
                                    className="library-item"
                                >

                                    <div className="library-item-preview">

                                        {item.type === "video-generation" ? (

                                            item.videoUrl ? (

                                                <LibraryVideoPlayer
                                                    src={item.videoUrl}
                                                />

                                            ) : null

                                        ) : (

                                            item.imageUrl ? (

                                                <img
                                                    src={item.imageUrl}
                                                    alt={
                                                        item.type === "face-swap"
                                                            ? "Face Swap gerado"
                                                            : "Imagem gerada"
                                                    }
                                                    className="library-item-image"
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

                                                {item.type === "video-generation"
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
                                                    item.type === "video-generation"
                                                        ? !item.videoUrl
                                                        : !item.imageUrl
                                                )
                                            }
                                            aria-label={
                                                downloadingId === item.id
                                                    ? "Baixando arquivo"
                                                    : item.type === "video-generation"
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
import "./Library.css";

import {
    useEffect,
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
} from "lucide-react";

export default function Library() {

const { user } = useAuth();

const [items, setItems] =
    useState<LibraryItem[]>([]);

type LibraryFilter =
    | "all"
    | "face-swap"
    | "image-generation"
    | "video-generation";

const [activeFilter, setActiveFilter] =
    useState<LibraryFilter>("all");

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

                                            <video
                                                src={item.videoUrl}
                                                className="library-item-video"
                                                controls
                                                preload="metadata"
                                            />

                                        ) : (

                                            <img
                                                src={item.imageUrl}
                                                alt="Imagem gerada"
                                                className="library-item-image"
                                            />

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
                                            aria-label={
                                                item.type === "video-generation"
                                                    ? "Baixar vídeo"
                                                    : "Baixar imagem"
                                            }
                                        >

                                            <Download size={18} />

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
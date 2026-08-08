import "./ImageGeneration.css";

import {
    useEffect,
    useRef,
    useState,
} from "react";

import {
    createTextToImage,
    getImageTask,
} from "../../api/imageGeneration";

import {
    ImagePlus,
    Sparkles,
    X,
    Image as ImageIcon,
    Square,
    RectangleHorizontal,
    RectangleVertical,
    Layers3,
} from "lucide-react";

import { useAuth } from "../../contexts/AuthContext";

import {
    uploadImageFromUrl,
} from "../../services/storage";

import {
    createLibraryImage,
} from "../../services/library";

type AspectRatio =
    | "1:1"
    | "16:9"
    | "9:16"
    | "4:5";

type ImageStyle =
    | "realistic"
    | "artistic"
    | "anime"
    | "3d";

type ImageQuantity =
    | 1
    | 2
    | 4;

interface ImageStyleOption {

    id: ImageStyle;

    title: string;

    description: string;

}

const imageStyles: ImageStyleOption[] = [

    {
        id: "realistic",
        title: "Realista",
        description: "Imagens com aparência fotográfica.",
    },

    {
        id: "artistic",
        title: "Artístico",
        description: "Composição criativa e estilizada.",
    },

    {
        id: "anime",
        title: "Anime",
        description: "Visual inspirado em animações.",
    },

    {
        id: "3d",
        title: "3D",
        description: "Renderização tridimensional moderna.",
    },

];

export default function ImageGeneration() {

const { user } = useAuth();

    const fileInputRef =
        useRef<HTMLInputElement | null>(null);

    const [prompt, setPrompt] =
        useState("");

    const [referenceImage, setReferenceImage] =
        useState<File | null>(null);

    const [referencePreview, setReferencePreview] =
        useState<string | null>(null);

    const [aspectRatio, setAspectRatio] =
        useState<AspectRatio>("1:1");

    const [imageStyle, setImageStyle] =
        useState<ImageStyle>("realistic");

    const [quantity, setQuantity] =
        useState<ImageQuantity>(1);


    
    const [isGenerating, setIsGenerating] =
        useState(false);

    const [error, setError] =
        useState("");

const [
    generatedImageUrl,
    setGeneratedImageUrl,
] = useState("");

    useEffect(() => {

        return () => {

            if (referencePreview) {

                URL.revokeObjectURL(
                    referencePreview
                );

            }

        };

    }, [referencePreview]);


    function openFileSelector() {

        fileInputRef.current?.click();

    }


    function handleReferenceImage(
        file: File | undefined
    ) {

        if (!file) {

            return;

        }

        if (!file.type.startsWith("image/")) {

            return;

        }

        if (referencePreview) {

            URL.revokeObjectURL(
                referencePreview
            );

        }

        const previewUrl =
            URL.createObjectURL(file);

        setReferenceImage(file);

        setReferencePreview(previewUrl);

    }


    function handleFileChange(
        event: React.ChangeEvent<HTMLInputElement>
    ) {

        const file =
            event.target.files?.[0];

        handleReferenceImage(file);

        event.target.value = "";

    }


    function handleDrop(
        event: React.DragEvent<HTMLDivElement>
    ) {

        event.preventDefault();

        const file =
            event.dataTransfer.files?.[0];

        handleReferenceImage(file);

    }


    function removeReferenceImage() {

        if (referencePreview) {

            URL.revokeObjectURL(
                referencePreview
            );

        }

        setReferenceImage(null);

        setReferencePreview(null);

    }

    function wait(ms: number) {

        return new Promise((resolve) => {

            setTimeout(resolve, ms);

        });

    }


async function waitForImageTask(
    taskId: string
) {

    while (true) {

        const task =
            await getImageTask(taskId);

        console.log(
            "Status da imagem:",
            task
        );

        if (
            task.taskStatus === "SUCCEEDED"
        ) {

            return task;

        }

        if (
            task.taskStatus === "FAILED"
        ) {

            throw new Error(
                task.errorMsg ||
                "A geração da imagem falhou."
            );

        }

        await wait(3000);

    }

}

async function handleGenerateImage() {

    if (!user) {

        setError(
            "Você precisa estar conectado para gerar uma imagem."
        );

        return;

    }

    if (!prompt.trim()) {

        setError(
            "Digite um prompt primeiro."
        );

        return;

    }

    try {

        setIsGenerating(true);
        setError("");
        setGeneratedImageUrl("");

        // 1. Cria a task na DeepSwap
        const task =
            await createTextToImage(
                prompt
            );

        console.log(
            "Task de imagem criada:",
            task
        );

        // 2. Aguarda a geração terminar
        const result =
            await waitForImageTask(
                task.taskId
            );

        console.log(
            "Imagem finalizada:",
            result
        );

        if (!result.videoUrl) {

            throw new Error(
                "A API não retornou a imagem gerada."
            );

        }

        console.log(
            "URL temporária da imagem:",
            result.videoUrl
        );

        // 3. Salva a imagem no Firebase Storage
        const firebaseImageUrl =
            await uploadImageFromUrl(
                result.videoUrl,
                `users/${user.uid}/images`
            );

        console.log(
            "Imagem salva no Firebase:",
            firebaseImageUrl
        );

        // 4. Registra na biblioteca / Firestore
        await createLibraryImage(
            user.uid,
            firebaseImageUrl,
            "image-generation"
        );

        console.log(
            "Imagem salva na biblioteca."
        );

        // 5. Exibe o resultado permanente
        setGeneratedImageUrl(
            firebaseImageUrl
        );

    } catch (error) {

        console.error(
            "Erro ao gerar imagem:",
            error
        );

        setError(
            error instanceof Error
                ? error.message
                : "Erro ao gerar imagem."
        );

    } finally {

        setIsGenerating(false);

    }

}

    return (

        <main className="image-generation">

            <div className="image-generation-container">

                <header className="image-generation-header">

                    <h1 className="image-generation-title">

                        Image <span>Generation</span>

                    </h1>

                    <p className="image-generation-description">

                        Transforme suas ideias em imagens únicas com inteligência artificial. Descreva o que deseja criar, escolha o estilo e personalize o resultado.

                    </p>

                </header>


                <section className="image-generation-layout">

                    <div className="image-generation-workspace">

                        {/* PROMPT */}

                        <section className="image-generation-card">

                            <div className="image-generation-section-header">

                                <div className="image-generation-section-icon">

                                    <Sparkles size={23} />

                                </div>

                                <div>

                                    <h2>

                                        Descreva sua imagem

                                    </h2>

                                    <p>

                                        Quanto mais detalhada for sua descrição, melhor será o resultado gerado.

                                    </p>

                                </div>

                            </div>


                            <div className="image-generation-prompt-wrapper">

                                <textarea
                                    className="image-generation-prompt"
                                    value={prompt}
                                    maxLength={1500}
                                    placeholder="Ex.: Uma cidade futurista durante a noite, iluminada por luzes neon vermelhas, carros voadores, chuva refletindo nas ruas e atmosfera cinematográfica..."
                                    onChange={(event) =>
                                        setPrompt(
                                            event.target.value
                                        )
                                    }
                                />

                                <span className="image-generation-prompt-counter">

                                    {prompt.length}/1500

                                </span>

                            </div>

                        </section>


                        {/* REFERENCE IMAGE */}

                        <section className="image-generation-card">

                            <div className="image-generation-section-header">

                                <div className="image-generation-section-icon">

                                    <ImagePlus size={23} />

                                </div>

                                <div>

                                    <h2>

                                        Imagem de referência

                                    </h2>

                                    <p>

                                        Adicione uma imagem opcional para orientar o estilo ou a composição da geração.

                                    </p>

                                </div>

                            </div>


                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/png,image/jpeg,image/webp"
                                hidden
                                onChange={handleFileChange}
                            />


                            {

                                referencePreview ?

                                    <div className="image-generation-reference-preview">

                                        <img
                                            src={referencePreview}
                                            alt="Imagem de referência selecionada"
                                        />

                                        <div className="image-generation-reference-overlay">

                                            <button
                                                type="button"
                                                className="image-generation-reference-change"
                                                onClick={openFileSelector}
                                            >

                                                Trocar imagem

                                            </button>

                                            <button
                                                type="button"
                                                className="image-generation-reference-remove"
                                                aria-label="Remover imagem"
                                                onClick={removeReferenceImage}
                                            >

                                                <X size={20} />

                                            </button>

                                        </div>

                                    </div>

                                    :

                                    <div
                                        className="image-generation-upload"
                                        role="button"
                                        tabIndex={0}
                                        onClick={openFileSelector}
                                        onDragOver={(event) =>
                                            event.preventDefault()
                                        }
                                        onDrop={handleDrop}
                                        onKeyDown={(event) => {

                                            if (
                                                event.key === "Enter" ||
                                                event.key === " "
                                            ) {

                                                openFileSelector();

                                            }

                                        }}
                                    >

                                        <div className="image-generation-upload-icon">

                                            <ImagePlus size={40} />

                                        </div>

                                        <h3>

                                            Envie uma imagem

                                        </h3>

                                        <p>

                                            Arraste uma imagem para esta área ou clique para selecionar um arquivo.

                                        </p>

                                        <span>

                                            PNG • JPG • JPEG • WEBP

                                        </span>

                                        <button
                                            type="button"
                                            className="image-generation-upload-button"
                                        >

                                            Selecionar imagem

                                        </button>

                                    </div>

                            }

                        </section>


                        {/* SETTINGS */}

                        <section className="image-generation-card">

                            <div className="image-generation-section-header">

                                <div className="image-generation-section-icon">

                                    <Layers3 size={23} />

                                </div>

                                <div>

                                    <h2>

                                        Configurações

                                    </h2>

                                    <p>

                                        Personalize o formato, o estilo e a quantidade de imagens.

                                    </p>

                                </div>

                            </div>


                            <div className="image-generation-settings">

                                <div className="image-generation-setting">

                                    <h3>

                                        Proporção

                                    </h3>

                                    <div className="image-generation-ratio-grid">

                                        <button
                                            type="button"
                                            className={
                                                aspectRatio === "1:1"
                                                    ? "image-generation-ratio image-generation-ratio-active"
                                                    : "image-generation-ratio"
                                            }
                                            onClick={() =>
                                                setAspectRatio("1:1")
                                            }
                                        >

                                            <Square size={22} />

                                            <span>1:1</span>

                                            <small>Quadrado</small>

                                        </button>

                                        <button
                                            type="button"
                                            className={
                                                aspectRatio === "16:9"
                                                    ? "image-generation-ratio image-generation-ratio-active"
                                                    : "image-generation-ratio"
                                            }
                                            onClick={() =>
                                                setAspectRatio("16:9")
                                            }
                                        >

                                            <RectangleHorizontal size={25} />

                                            <span>16:9</span>

                                            <small>Paisagem</small>

                                        </button>

                                        <button
                                            type="button"
                                            className={
                                                aspectRatio === "9:16"
                                                    ? "image-generation-ratio image-generation-ratio-active"
                                                    : "image-generation-ratio"
                                            }
                                            onClick={() =>
                                                setAspectRatio("9:16")
                                            }
                                        >

                                            <RectangleVertical size={25} />

                                            <span>9:16</span>

                                            <small>Vertical</small>

                                        </button>

                                        <button
                                            type="button"
                                            className={
                                                aspectRatio === "4:5"
                                                    ? "image-generation-ratio image-generation-ratio-active"
                                                    : "image-generation-ratio"
                                            }
                                            onClick={() =>
                                                setAspectRatio("4:5")
                                            }
                                        >

                                            <RectangleVertical size={23} />

                                            <span>4:5</span>

                                            <small>Retrato</small>

                                        </button>

                                    </div>

                                </div>


                                <div className="image-generation-setting">

                                    <h3>

                                        Estilo

                                    </h3>

                                    <div className="image-generation-style-grid">

                                        {

                                            imageStyles.map(
                                                style => (

                                                    <button
                                                        key={style.id}
                                                        type="button"
                                                        className={
                                                            imageStyle === style.id
                                                                ? "image-generation-style image-generation-style-active"
                                                                : "image-generation-style"
                                                        }
                                                        onClick={() =>
                                                            setImageStyle(
                                                                style.id
                                                            )
                                                        }
                                                    >

                                                        <ImageIcon size={21} />

                                                        <div>

                                                            <strong>

                                                                {style.title}

                                                            </strong>

                                                            <span>

                                                                {style.description}

                                                            </span>

                                                        </div>

                                                    </button>

                                                )
                                            )

                                        }

                                    </div>

                                </div>


                                <div className="image-generation-setting">

                                    <h3>

                                        Quantidade

                                    </h3>

                                    <div className="image-generation-quantity">

                                        {

                                            ([1, 2, 4] as ImageQuantity[])
                                                .map(value => (

                                                    <button
                                                        key={value}
                                                        type="button"
                                                        className={
                                                            quantity === value
                                                                ? "image-generation-quantity-button image-generation-quantity-button-active"
                                                                : "image-generation-quantity-button"
                                                        }
                                                        onClick={() =>
                                                            setQuantity(value)
                                                        }
                                                    >

                                                        {value}

                                                        {
                                                            value === 1
                                                                ? " imagem"
                                                                : " imagens"
                                                        }

                                                    </button>

                                                ))

                                        }

                                    </div>

                                </div>

                            </div>

                        </section>


                        <button
                            type="button"
                            className="image-generation-button"
                            disabled={
                                !prompt.trim() ||
                                isGenerating
                            }
                            onClick={handleGenerateImage}
                        >

                            <Sparkles size={21} />

                            {
                                isGenerating
                                    ? "Gerando imagem..."
                                    : "Gerar imagem"
                            }

                        </button>

                        {error && (

                            <div className="image-generation-error">

                                {error}

                            </div>

                        )}

                    </div>


                    {/* PREVIEW / RESULT */}

                    <aside className="image-generation-sidebar">

                        <section className="image-generation-result-card">

                            <div className="image-generation-result-header">

                                <h2>

                                    Resultado

                                </h2>

                                <p>

                                    Sua imagem aparecerá aqui após a geração.

                                </p>

                            </div>

                            {isGenerating ? (

                                <div className="image-generation-result-loading">

                                    <div className="image-generation-result-spinner" />

                                    <strong>
                                        Gerando sua imagem...
                                    </strong>

                                    <span>
                                        Aguarde enquanto a Xia cria seu resultado.
                                    </span>

                                </div>

                            ) : generatedImageUrl ? (

                                <div className="image-generation-result-ready">

                                    <img
                                        src={generatedImageUrl}
                                        alt="Imagem gerada"
                                        className="image-generation-result-image"
                                    />

                                </div>

                            ) : (

                                <div className="image-generation-result-empty">

                                    <div className="image-generation-result-icon">

                                        <ImageIcon size={42} />

                                    </div>

                                    <strong>
                                        Nenhuma imagem gerada
                                    </strong>

                                    <span>
                                        Escreva um prompt e clique em gerar para visualizar seu resultado.
                                    </span>

                                </div>

                            )}

                        </section>

                    </aside>

                </section>

            </div>

        </main>

    );

}
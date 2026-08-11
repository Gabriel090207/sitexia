import {
    useEffect,
    useRef,
    useState,
} from "react";

import { useSearchParams } from "react-router-dom";

import {
    doc,
    onSnapshot,
} from "firebase/firestore";

import db from "../../firebase/firestore";

import "./VideoGeneration.css";

import {
    ImagePlus,
    Clock3,
    Images,
    MessageSquareText,
    ArrowLeft,
    X,
    Video,
    Coins,
} from "lucide-react";

import {
    uploadFile,
} from "../../services/storage";

import { useAuth } from "../../contexts/AuthContext";

import {
    createLibraryVideo,
    subscribeToLibrary,
    type LibraryItem,
} from "../../services/library";

import {
    createImageToVideo,
    createVideoExtend,
    createReferenceToVideo,
    createTextToVideo,
    getVideoTask,
} from "../../api/videoGeneration";


export default function VideoGeneration() {

const { user } = useAuth();

const [credits, setCredits] =
    useState<number>(0);

const [searchParams] = useSearchParams();

type VideoMode =
    | "image-to-video"
    | "video-extend"
    | "reference-to-video"
    | "text-to-video";

const [activeMode, setActiveMode] =
    useState<VideoMode>(() => {

        const mode = searchParams.get("mode");

        if (mode === "text-to-video") {
            return "text-to-video";
        }

        return "image-to-video";

    });

const imageInputRef =
    useRef<HTMLInputElement>(null);



const [imagePreview, setImagePreview] =
    useState<string | null>(null);

const [imageUrl, setImageUrl] =
    useState("");

const [prompt, setPrompt] =
    useState("");  

const [duration, setDuration] =
    useState<5 | 10 | 15>(5);

const generationCost =
    activeMode === "reference-to-video"
        ? (duration / 5) * 2
        : (duration / 5) * 1.2;

const [isUploading, setIsUploading] =
    useState(false);

const [isGenerating, setIsGenerating] =
    useState(false);

const [generationStatus, setGenerationStatus] =
    useState("");

const [generatedVideoUrl, setGeneratedVideoUrl] =
    useState("");

const [error, setError] =
    useState("");

const [libraryVideos, setLibraryVideos] =
    useState<LibraryItem[]>([]);

const [selectedSourceVideo, setSelectedSourceVideo] =
    useState<LibraryItem | null>(null);

const [isVideoSelectorOpen, setIsVideoSelectorOpen] =
    useState(false);

const hasRequiredMedia =
    activeMode === "video-extend"
        ? !!selectedSourceVideo?.taskId
        : !!imageUrl;

const hasEnoughCredits =
    credits >= generationCost;

const canGenerate =
    !!user &&
    hasRequiredMedia &&
    !!prompt.trim() &&
    hasEnoughCredits &&
    !isUploading &&
    !isGenerating;

const generateBlockedMessage =
    !user
        ? "Faça login para gerar um vídeo."
        : !hasRequiredMedia
            ? activeMode === "video-extend"
                ? "Selecione um vídeo para continuar."
                : "Selecione uma imagem para continuar."
            : !prompt.trim()
                ? "Escreva um prompt para continuar."
                : !hasEnoughCredits
                    ? `Créditos insuficientes. Esta geração custa ${generationCost.toLocaleString(
                        "pt-BR",
                        {
                            minimumFractionDigits: 1,
                            maximumFractionDigits: 1,
                        }
                    )} créditos.`
                    : "";
   
useEffect(() => {

    if (!user) {
        setCredits(0);
        return;
    }

    const userRef = doc(
        db,
        "users",
        user.uid
    );

    const unsubscribe = onSnapshot(
        userRef,
        (snapshot) => {

            if (!snapshot.exists()) {
                setCredits(0);
                return;
            }

            const data = snapshot.data();

            setCredits(
                Number(data.credits ?? 0)
            );
        }
    );

    return () => {
        unsubscribe();
    };

}, [user]);

useEffect(() => {

    if (!user) {

        setLibraryVideos([]);

        return;

    }

    const unsubscribe =
        subscribeToLibrary(
            user.uid,
            (items) => {

                const videos =
                    items.filter((item) => {

                        return (
                            item.type === "video-generation" &&
                            Boolean(item.videoUrl)
                        );

                    });

                setLibraryVideos(videos);

            }
        );

    return () => {

        unsubscribe();

    };

}, [user]);


function handleModeChange(
    mode: VideoMode
) {

    if (activeMode === mode) {
        return;
    }

    if (imagePreview) {
        URL.revokeObjectURL(imagePreview);
    }

    setActiveMode(mode);

  
    setImagePreview(null);
    setImageUrl("");

    setSelectedSourceVideo(null);

    setPrompt("");
    setDuration(5);
    setError("");
    setGeneratedVideoUrl("");
    setGenerationStatus("");

    if (imageInputRef.current) {
        imageInputRef.current.value = "";
    }

}

async function handleImageChange(
    event: React.ChangeEvent<HTMLInputElement>
) {

    const file = event.target.files?.[0];

    if (!file) {
        return;
    }



    const previewUrl =
        URL.createObjectURL(file);

    setImagePreview(previewUrl);

    setImageUrl("");
    setGeneratedVideoUrl("");
    setError("");

    try {

        setIsUploading(true);

        const uploadedUrl =
            await uploadFile(
                file,
                "video-generation"
            );

        setImageUrl(uploadedUrl);

        console.log(
            "Imagem do vídeo enviada:",
            uploadedUrl
        );

    } catch (error) {

        console.error(
            "Erro ao enviar imagem:",
            error
        );

        setError(
            "Não foi possível enviar a imagem. Tente novamente."
        );

    } finally {

        setIsUploading(false);

    }

}

function wait(ms: number) {

    return new Promise((resolve) => {

        setTimeout(resolve, ms);

    });

}

async function waitForVideoTask(
    taskId: string
) {

    while (true) {

        const task =
            await getVideoTask(taskId);

        console.log(
            "Status do vídeo:",
            task
        );

        if (task.taskStatus === "PENDING") {

            setGenerationStatus(
                "Preparando geração..."
            );

        }

        if (task.taskStatus === "RUNNING") {

            setGenerationStatus(
                "Gerando seu vídeo..."
            );

        }

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
                "A geração do vídeo falhou."
            );

        }

        await wait(5000);

    }

}

async function videoUrlToFile(
    videoUrl: string
): Promise<File> {

    const response =
        await fetch(videoUrl);

    if (!response.ok) {

        throw new Error(
            "Não foi possível baixar o vídeo gerado."
        );

    }

    const blob =
        await response.blob();

    return new File(
        [blob],
        `video-${Date.now()}.mp4`,
        {
            type:
                blob.type ||
                "video/mp4",
        }
    );

}

async function handleGenerateVideo() {

    if (isUploading) {

        setError(
            "Aguarde o envio da imagem terminar."
        );

        return;

    }

    if (
        activeMode === "image-to-video" &&
        !imageUrl
    ) {

        setError(
            "Selecione uma imagem primeiro."
        );

        return;

    }

    if (
        activeMode === "reference-to-video" &&
        !imageUrl
    ) {

        setError(
            "Selecione uma imagem de referência primeiro."
        );

        return;

    }

    if (
        activeMode === "text-to-video" &&
        !imageUrl
    ) {

        setError(
            "Selecione uma imagem de referência primeiro."
        );

        return;

    }

    if (
        activeMode === "video-extend" &&
        !selectedSourceVideo?.taskId
    ) {

        setError(
            "Selecione um vídeo primeiro."
        );

        return;

    }

    if (!prompt.trim()) {

        setError(
            "Digite um prompt antes de gerar o vídeo."
        );

        return;

    }

    if (!user) {

        setError(
            "Usuário não autenticado."
        );

        return;

    }

    try {

        setError("");
        setGeneratedVideoUrl("");
        setIsGenerating(true);

        setGenerationStatus(
            activeMode === "video-extend"
                ? "Preparando extensão..."
                : "Criando vídeo..."
        );

        let task;

        if (activeMode === "video-extend") {

            task = await createVideoExtend(
                selectedSourceVideo!.taskId!,
                prompt,
                duration,
                user.uid
            );

        } else if (
            activeMode === "reference-to-video"
        ) {

            task = await createReferenceToVideo(
                imageUrl,
                prompt,
                duration,
                user.uid
            );

        } else if (
            activeMode === "text-to-video"
        ) {

            task = await createTextToVideo(
                prompt,
                imageUrl,
                duration,
                user.uid
            );

        } else {

            task = await createImageToVideo(
                imageUrl,
                prompt,
                duration,
                user.uid
            );

        }

        console.log(
            "Task de vídeo criada:",
            task
        );

        setGenerationStatus(
            "Preparando geração..."
        );

        const result =
            await waitForVideoTask(
                task.taskId
            );

        console.log(
            "Vídeo finalizado:",
            result
        );

        if (!result.videoUrl) {

            throw new Error(
                "A geração terminou sem retornar o vídeo."
            );

        }

        setGenerationStatus(
            "Salvando seu vídeo..."
        );

        const videoFile =
            await videoUrlToFile(
                result.videoUrl
            );

        const firebaseVideoUrl =
            await uploadFile(
                videoFile,
                `users/${user.uid}/videos`
            );

        console.log(
            "Vídeo salvo no Firebase:",
            firebaseVideoUrl
        );

        await createLibraryVideo(
            user.uid,
            firebaseVideoUrl,
            task.taskId
        );

        console.log(
            "Vídeo salvo na biblioteca."
        );

        setGeneratedVideoUrl(
            firebaseVideoUrl
        );

        setGenerationStatus("");

    } catch (error) {

        console.error(
            "Erro ao gerar vídeo:",
            error
        );

        setGenerationStatus("");

        setError(
            error instanceof Error
                ? error.message
                : "Não foi possível gerar o vídeo."
        );

    } finally {

        setIsGenerating(false);

    }

}

    return (

        <main className="video-generation">

            <div className="video-generation-container">

                <div className="video-generation-credits">
                    <Coins size={20} />

                    <span>
                        {credits} {credits === 1 ? "crédito" : "créditos"}
                    </span>
                </div>

                <header className="video-generation-header">

                    <h1 className="video-generation-title">

                        Video <span>Generation</span>

                    </h1>

                    <p className="video-generation-description">

                        Transforme imagens e textos em vídeos utilizando inteligência artificial de alta qualidade.

                    </p>

                </header>

                <section className="video-generation-card">

                   {/* MODES */}

                    {!isGenerating && !generatedVideoUrl && (

                        <div className="video-generation-modes">

                            <button
                                type="button"
                                className={`video-generation-mode ${
                                    activeMode === "image-to-video"
                                        ? "video-generation-mode-active"
                                        : ""
                                }`}
                                onClick={() =>
                                    handleModeChange("image-to-video")
                                }
                            >

                                <ImagePlus size={22} />

                                <span>
                                    Imagem para Vídeo
                                </span>

                            </button>


                            <button
                                type="button"
                                className={`video-generation-mode ${
                                    activeMode === "video-extend"
                                        ? "video-generation-mode-active"
                                        : ""
                                }`}
                                onClick={() =>
                                    handleModeChange("video-extend")
                                }
                            >

                                <Clock3 size={22} />

                                <span>
                                    Estender Vídeo
                                </span>

                            </button>


                            <button
                                type="button"
                                className={`video-generation-mode ${
                                    activeMode === "reference-to-video"
                                        ? "video-generation-mode-active"
                                        : ""
                                }`}
                                onClick={() =>
                                    handleModeChange("reference-to-video")
                                }
                            >

                                <Images size={22} />

                                <span>
                                    Referência para Vídeo
                                </span>

                                <small>
                                    Novo
                                </small>

                            </button>


                            <button
                                type="button"
                                className={`video-generation-mode ${
                                    activeMode === "text-to-video"
                                        ? "video-generation-mode-active"
                                        : ""
                                }`}
                                onClick={() =>
                                    handleModeChange("text-to-video")
                                }
                            >

                                <MessageSquareText size={22} />

                                <span>
                                    Texto para Vídeo
                                </span>

                            </button>

                        </div>

                    )}


                        {/* =========================
                            CONTENT
                        ========================= */}

                        {isGenerating ? (

                            /* GENERATING */

                            <div className="video-generation-generation-loading">

                                <div className="video-generation-generation-spinner" />

                                <p>
                                    {generationStatus || "Gerando seu vídeo..."}
                                </p>

                            </div>

                        ) : generatedVideoUrl ? (

                            /* RESULT */

                            <div className="video-generation-generation-result">

                                <button
                                    type="button"
                                    className="video-generation-back-button"
                                    onClick={() => {

                                        setGeneratedVideoUrl("");

                                        setImageUrl("");

                                        setImagePreview(null);

                                   

                                        setPrompt("");

                                        setError("");

                                        setGenerationStatus("");

                                    }}
                                >

                                    <ArrowLeft size={18} />

                                    <span>
                                        Voltar
                                    </span>

                                </button>

                                <video
                                    src={generatedVideoUrl}
                                    controls
                                    playsInline
                                    className="video-generation-generation-video"
                                />

                            </div>

                        ) : (

                            /* FORM */

                            <>

                                {/* UPLOAD */}


                                {activeMode === "video-extend" ? (

                                   <div className="video-generation-upload">

                                        {selectedSourceVideo?.videoUrl ? (

                                            <div className="video-generation-preview">

                                                <video
                                                    src={selectedSourceVideo.videoUrl}
                                                    controls
                                                    playsInline
                                                    className="video-generation-preview-video"
                                                />

                                                <button
                                                    type="button"
                                                    className="video-generation-upload-button video-generation-change-button"
                                                    onClick={() =>
                                                        setIsVideoSelectorOpen(true)
                                                    }
                                                >
                                                    Trocar vídeo
                                                </button>

                                            </div>

                                        ) : (

                                            <div className="video-generation-upload-content">

                                                <div className="video-generation-upload-icon">

                                                    <Clock3 size={42} />

                                                </div>

                                                <h2 className="video-generation-upload-title">
                                                    Selecione seu vídeo
                                                </h2>

                                                <p className="video-generation-upload-description">
                                                    Escolha um vídeo gerado anteriormente com a Xia para continuar a criação.
                                                </p>

                                                <span className="video-generation-upload-formats">
                                                    VÍDEOS DA SUA BIBLIOTECA
                                                </span>

                                                <button
                                                    className="video-generation-upload-button"
                                                    type="button"
                                                    onClick={() =>
                                                        setIsVideoSelectorOpen(true)
                                                    }
                                                >
                                                    Selecionar vídeo
                                                </button>

                                            </div>

                                        )}

                                    </div>

                                ) : (

                                <div className="video-generation-upload">

                                    <input
                                        ref={imageInputRef}
                                        type="file"
                                        accept="image/png,image/jpeg,image/webp"
                                        onChange={handleImageChange}
                                        hidden
                                    />

                                    {isUploading ? (

                                        <div className="video-generation-upload-loading">

                                            <div className="video-generation-upload-spinner" />

                                        </div>

                                    ) : imagePreview ? (

                                        <div className="video-generation-preview">

                                            <img
                                                src={imagePreview}
                                                alt="Imagem selecionada"
                                                className="video-generation-preview-image"
                                            />

                                            <button
                                                type="button"
                                                className="video-generation-upload-button video-generation-change-button"
                                                onClick={() =>
                                                    imageInputRef.current?.click()
                                                }
                                            >
                                                Trocar imagem
                                            </button>

                                        </div>

                                    ) : (

                                        <div className="video-generation-upload-content">

                                            <div className="video-generation-upload-icon">

                                                <ImagePlus size={42} />

                                            </div>

                                            <h2 className="video-generation-upload-title">

                                                {activeMode === "reference-to-video" ||
                                                activeMode === "text-to-video"
                                                    ? "Envie sua imagem de referência"
                                                    : "Envie sua imagem"}

                                            </h2>

                                            <p className="video-generation-upload-description">

                                                {activeMode === "reference-to-video"
                                                    ? "Envie uma imagem de referência para orientar a criação do vídeo."
                                                    : activeMode === "text-to-video"
                                                        ? "Envie uma imagem de referência para auxiliar a geração do vídeo a partir do seu texto."
                                                        : "Arraste uma imagem para esta área ou clique no botão abaixo para selecionar um arquivo."}

                                            </p>

                                            <span className="video-generation-upload-formats">

                                                PNG • JPG • JPEG • WEBP

                                            </span>

                                            <button
                                                className="video-generation-upload-button"
                                                type="button"
                                                onClick={() =>
                                                    imageInputRef.current?.click()
                                                }
                                            >

                                                Selecionar imagem

                                            </button>

                                        </div>

                                    )}

                                </div>

                                )}


                                {/* PROMPT */}

                                <div className="video-generation-prompt">

                                    <h2 className="video-generation-prompt-title">

                                        Prompt

                                    </h2>

                                    <p className="video-generation-prompt-description">

                                        Descreva como você deseja que o vídeo seja gerado. Quanto mais detalhes você fornecer, melhor será o resultado.

                                    </p>

                                    <textarea
                                        className="video-generation-prompt-textarea"
                                        placeholder="Ex.: A personagem caminha lentamente olhando para a câmera enquanto o vento movimenta seus cabelos..."
                                        value={prompt}
                                        onChange={(event) =>
                                            setPrompt(event.target.value)
                                        }
                                    />

                                    {/* DURATION */}

                                    <div className="video-generation-duration">

                                        <h2 className="video-generation-duration-title">
                                            Duração
                                        </h2>

                                        <p className="video-generation-duration-description">
                                            Escolha a duração do vídeo que será gerado.
                                        </p>

                                        <div className="video-generation-duration-options">

                                            {([5, 10, 15] as const).map((seconds) => (

                                                <button
                                                    key={seconds}
                                                    type="button"
                                                    className={`video-generation-duration-option ${
                                                        duration === seconds
                                                            ? "video-generation-duration-option-active"
                                                            : ""
                                                    }`}
                                                    onClick={() =>
                                                        setDuration(seconds)
                                                    }
                                                >
                                                    {seconds}s
                                                </button>

                                            ))}

                                        </div>

                                    </div>

                                </div>

                            </>

                        )}

                        </section>


                        {/* =========================
                            GENERATE BUTTON
                        ========================= */}

                        {!isGenerating && !generatedVideoUrl && (

                            <>

                                <button
                                    type="button"
                                    className="video-generation-button"
                                    onClick={handleGenerateVideo}
                                    disabled={!canGenerate}
                                >

                                    {activeMode === "video-extend"
                                        ? "Estender Vídeo"
                                        : "Gerar Vídeo"}

                                </button>

                                {generateBlockedMessage && (
                                    <p className="video-generation-blocked-message">
                                        {generateBlockedMessage}
                                    </p>
                                )}

                            </>

                        )}


                        {/* =========================
                            ERROR
                        ========================= */}

                        {error && (

                            <div className="video-generation-error">

                                {error}

                            </div>

                        )} 

                        {isVideoSelectorOpen && (

                            <div
                                className="video-generation-selector-overlay"
                                onClick={() =>
                                    setIsVideoSelectorOpen(false)
                                }
                            >

                                <div
                                    className="video-generation-selector"
                                    onClick={(event) =>
                                        event.stopPropagation()
                                    }
                                >

                                    <div className="video-generation-selector-header">

                                        <div>

                                            <h2>
                                                Selecione um vídeo
                                            </h2>

                                            <p>
                                                Escolha um vídeo da sua biblioteca para continuar a geração.
                                            </p>

                                        </div>

                                        <button
                                            type="button"
                                            className="video-generation-selector-close"
                                            onClick={() =>
                                                setIsVideoSelectorOpen(false)
                                            }
                                        >

                                            <X size={20} />

                                        </button>

                                    </div>

                                    {libraryVideos.length > 0 ? (

                                        <div className="video-generation-selector-grid">

                                            {libraryVideos.map((item) => (

                                                <button
                                                    key={item.id}
                                                    type="button"
                                                    className="video-generation-selector-item"
                                                    onClick={() => {

                                                        if (!item.taskId) {

                                                            setError(
                                                                "Este vídeo não pode ser estendido porque não possui a tarefa de geração original."
                                                            );

                                                            setIsVideoSelectorOpen(false);

                                                            return;

                                                        }

                                                        setSelectedSourceVideo(item);

                                                        setIsVideoSelectorOpen(false);

                                                        setError("");

                                                    }}
                                                >

                                                    <video
                                                        src={item.videoUrl}
                                                        muted
                                                        playsInline
                                                        preload="metadata"
                                                    />

                                                </button>

                                            ))}

                                        </div>

                                    ) : (

                                        <div className="video-generation-selector-placeholder">

                                            <Video size={38} />

                                            <p>
                                                Nenhum vídeo disponível.
                                            </p>

                                        </div>

                                    )}

                                </div>

                            </div>

                        )}

            </div>

        </main>

    );

}
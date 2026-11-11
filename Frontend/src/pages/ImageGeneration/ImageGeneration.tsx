import PrivateGeneratedImage from "./PrivateGeneratedImage";
import auth from "../../firebase/auth";
import { processImageResults } from "./processImageResults";
import { formatCredits } from "../../utils/formatCredits";
import "./ImageGeneration.css";
import { getGenerationErrorMessage } from "../../utils/generationErrors";

import { Link } from "react-router-dom";

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
    Layers3,
    Coins,
} from "lucide-react";

import { useAuth } from "../../contexts/AuthContext";

import {
    doc,
    onSnapshot,
} from "firebase/firestore";

import db from "../../firebase/firestore";

import {
    uploadImageFromUrl,
} from "../../services/storage";

import {
    createLibraryImage,
} from "../../services/library";

type ImageStyle =
    | "realistic"
    | "anime";

type ImageQuantity =
    | 1
    | 4
    | 9;

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
        id: "anime",
        title: "Anime",
        description: "Visual inspirado em animações.",
    },

];

export default function ImageGeneration() {

const { user } = useAuth();

const [credits, setCredits] =
    useState(0);

    const fileInputRef =
        useRef<HTMLInputElement | null>(null);

    const [prompt, setPrompt] =
        useState("");

    

    const [referencePreview, setReferencePreview] =
        useState<string | null>(null);

    const [imageStyle, setImageStyle] =
        useState<ImageStyle>("realistic");

    const [quantity, setQuantity] =
        useState<ImageQuantity>(1);



const generationCost =
    quantity * 0.2;

const hasEnoughCredits =
    credits >= generationCost;
    
    
    const [isGenerating, setIsGenerating] =
        useState(false);

    const [error, setError] =
        useState("");

const [
    generatedImages,
    setGeneratedImages,
] = useState<{ url: string; owner: NonNullable<typeof user> }[]>([]);
const visibleImages = generatedImages.filter(image => image.owner === user);
const pageMounted = useRef(false);
useEffect(() => {
    pageMounted.current = true;
    return () => { pageMounted.current = false; };
}, []);
useEffect(() => { setGeneratedImages([]); }, [user]);
const generationInFlight = useRef(false);


const canGenerate =
    !!user &&
    !!prompt.trim() &&
    hasEnoughCredits &&
    !isGenerating;


const isBlockedByInsufficientCredits =
    !!user &&
    !!prompt.trim() &&
    !hasEnoughCredits;

const generateBlockedMessage =
    !user
        ? "Faça login para gerar uma imagem."
        : !prompt.trim()
            ? "Escreva um prompt para continuar."
            : !hasEnoughCredits
                ? `Créditos insuficientes. Esta geração custa ${formatCredits(generationCost)} créditos.`
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

    return () => unsubscribe();

}, [user]);

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

    if (generationInFlight.current) return;

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

    generationInFlight.current = true;
    try {

        setIsGenerating(true);
        setError("");
        setGeneratedImages([]);

        // 1. Cria a task na DeepSwap
        const task =
            await createTextToImage(
                prompt,
                imageStyle,
                quantity
            );

     
       

        // 2. Aguarda a geração terminar
        const result =
            await waitForImageTask(
                task.taskId
            );

       

        const outcome = await processImageResults(
            result.imageUrls,
            user.uid,
            crypto.randomUUID(),
            {
                upload: uploadImageFromUrl,
                register: createLibraryImage,
                onSaved: (url) => {
                    // Presentation only: storage and library registration stay unchanged.
                    if (pageMounted.current && auth.currentUser === user) {
                        setGeneratedImages((saved) => [...saved, { url, owner: user }]);
                    }
                },
            },
        );
        const warnings: string[] = [];
        if (outcome.uploadFailures) {
            warnings.push(`${outcome.uploadFailures} de ${outcome.total} imagens não puderam ser baixadas ou salvas. As imagens salvas estão exibidas no resultado.`);
        }
        if (outcome.libraryFailures) {
            warnings.push(`${outcome.libraryFailures} imagens foram salvas e estão exibidas, mas não puderam ser registradas na biblioteca.`);
        }
        if (warnings.length) setError(warnings.join(" "));

    } catch (error) {

        console.error(
            "Erro ao gerar imagem:",
            error
        );

        setError(
            getGenerationErrorMessage(
                error,
                error instanceof Error && error.message === "A API retornou uma URL de imagem inválida."
                    ? error.message
                    : "Não foi possível gerar a imagem. Tente novamente."
            )
        );

    } finally {

        generationInFlight.current = false;
        setIsGenerating(false);

    }

}

    return (

        <main className="image-generation">

            <div className="image-generation-container">

                 <div className="image-generation-credits">
                <Coins size={20} />

                    <span>
                        {formatCredits(credits)} {credits === 1 ? "crédito" : "créditos"}
                    </span>
                </div>

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

                                            ([1, 4, 9] as ImageQuantity[])
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
                            disabled={!canGenerate}
                            onClick={handleGenerateImage}
                        >

                            <Sparkles size={21} />

                            {
                                isGenerating
                                    ? "Gerando imagem..."
                                    : "Gerar imagem"
                            }

                        </button>

                        {isBlockedByInsufficientCredits ? (
                            <Link
                                to="/creditos"
                                className="image-generation-credits-cta"
                            >
                                Você não possui créditos suficientes. Recarregue aqui
                            </Link>
                        ) : generateBlockedMessage && (
                            <p className="image-generation-blocked-message">
                                {generateBlockedMessage}
                            </p>
                        )}

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

                            ) : visibleImages.length > 0 ? (

                                <div className="image-generation-result-ready">

                                    {visibleImages.map(({ url, owner }, index) => (
                                        <PrivateGeneratedImage
                                            key={`${index}-${url}`}
                                            value={url}
                                            uid={owner.uid}
                                            index={index}
                                        />
                                    ))}

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

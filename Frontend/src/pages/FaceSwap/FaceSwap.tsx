import PrivateLibraryVideo from "../Library/PrivateLibraryVideo";
import PrivateFaceSwapImage from "./PrivateFaceSwapImage";
import { createIntent, startSwapTask, swapOperationError } from "./faceSwapIntent";
import { FaceSwapFlowError, requireResultUrl, waitForFaceSwap } from "./faceSwapPolling";
import { getGenerationErrorMessage } from "../../utils/generationErrors";
import { formatCredits } from "../../utils/formatCredits";
import "./FaceSwap.css";
import {
    useEffect,
    useRef,
    useState,
} from "react";

import {
    doc,
    onSnapshot,
} from "firebase/firestore";

import db from "../../firebase/firestore";

import { Link } from "react-router-dom";

import { saveFaceSwapResult } from "./saveFaceSwapResult";
import { uploadScopedFile } from "../../services/scopedUploads";

import { useAuth } from "../../contexts/AuthContext";
import auth from "../../firebase/auth";
import { allowAuthenticatedUpload } from "../../utils/uploadAuthorization";

import {
    ArrowLeft,
    Plus,
    Coins,
} from "lucide-react";

import {
    createMaterial,
    getMaterial,
    createSwapTask,
    getSwapTask,
    getSwapResult,
} from "../../api/swap";

import {
    createLibraryImage,
    createLibraryVideo,
} from "../../services/library";

export default function FaceSwap() {

const { user, loading: authLoading } = useAuth();
const [uploadAuthError, setUploadAuthError] = useState("");
const canUpload = () => allowAuthenticatedUpload(user, authLoading, auth.currentUser, setUploadAuthError);

const [credits, setCredits] = useState<number>(0);
const [selectedFile, setSelectedFile] = useState<File | null>(null);
const [fileUrl, setFileUrl] = useState("");
const [filePreview, setFilePreview] = useState("");
const [selectedFace, setSelectedFace] = useState<File | null>(null);
const [facePreview, setFacePreview] = useState("");

useEffect(() => {
    if (!selectedFile) { setFilePreview(""); return; }
    const preview = URL.createObjectURL(selectedFile);
    setFilePreview(preview);
    return () => URL.revokeObjectURL(preview);
}, [selectedFile]);

useEffect(() => {
    if (!selectedFace) { setFacePreview(""); return; }
    const preview = URL.createObjectURL(selectedFace);
    setFacePreview(preview);
    return () => URL.revokeObjectURL(preview);
}, [selectedFace]);

const [videoDuration, setVideoDuration] =
    useState<number>(0);

const isVideo =
    selectedFile?.type.startsWith("video/") ?? false;

const isGif =
    selectedFile?.type === "image/gif";

const isImage =
    !!selectedFile && !isVideo && !isGif;

const generationCost =
    isVideo
        ? Math.max(
            1,
            Math.ceil(videoDuration / 15)
        )
        : isGif
            ? 1
            : isImage
                ? 0.1
                : 0;

const [loadingFile, setLoadingFile] = useState(false);

const [loadingFace, setLoadingFace] = useState(false);

const [faceUrl, setFaceUrl] =
    useState("");

const [privateResult, setPrivateResult] = useState<{
    owner: NonNullable<typeof user>; taskId: string; kind: "image" | "video" | "unknown"; reference?: string; libraryItemId?: string;
} | null>(null);
const [privateImageUrl, setPrivateImageUrl] = useState("");
const activeResult = privateResult?.owner === user && auth.currentUser === user ? privateResult : null;
const pageMounted = useRef(false);
useEffect(() => {
    pageMounted.current = true;
    return () => { pageMounted.current = false; };
}, []);

const fileInputRef = useRef<HTMLInputElement>(null);
const faceInputRef = useRef<HTMLInputElement>(null);

const generationInFlight = useRef(false);
const [generationError, setGenerationError] = useState("");

const [isGenerating, setIsGenerating] =
    useState(false);

const hasEnoughCredits =
    credits >= generationCost;

const canGenerate =
    !!user &&
    !loadingFile &&
    !loadingFace &&
    !!fileUrl &&
    !!faceUrl &&
    generationCost > 0 &&
    hasEnoughCredits &&
    !isGenerating;

const isBlockedByInsufficientCredits =
    !!user &&
    !!fileUrl &&
    !!faceUrl &&
    !hasEnoughCredits;

const generateBlockedMessage =
    !user
        ? "Faça login para criar um Face Swap."
        : !fileUrl
            ? "Selecione uma imagem ou vídeo para continuar."
            : !faceUrl
                ? "Adicione um rosto para continuar."
                : generationCost > credits
                    ? `Créditos insuficientes. Esta geração custa ${formatCredits(generationCost)} ${
                        generationCost === 1 ? "crédito" : "créditos"
                    }.`
                    : "";

useEffect(() => {
    setSelectedFile(null);
    setSelectedFace(null);
    setFileUrl("");
    setFaceUrl("");
    setPrivateResult(null);
    setPrivateImageUrl("");
    setGenerationError("");
    setCredits(0);
}, [user?.uid]);

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

            const total = Number(data.credits ?? 0);
            const reserved = Number(data.reservedCredits ?? 0);
            setCredits(Number.isFinite(total) && Number.isFinite(reserved)
                ? Math.max(0, total - Math.max(0, reserved)) : 0);
        }
    );

    return () => {
        unsubscribe();
    };

}, [user]);


function getVideoDuration(
    file: File
): Promise<number> {

    return new Promise((resolve, reject) => {

        const video =
            document.createElement("video");

        const objectUrl =
            URL.createObjectURL(file);

        video.preload = "metadata";

        video.onloadedmetadata = () => {

            const duration = video.duration;

            URL.revokeObjectURL(objectUrl);

            resolve(duration);
        };

        video.onerror = () => {

            URL.revokeObjectURL(objectUrl);

            reject(
                new Error(
                    "Não foi possível identificar a duração do vídeo."
                )
            );
        };

        video.src = objectUrl;
    });
}

async function handleGenerateSwap() {
    if (generationInFlight.current) return;
    if (activeResult) {
        const displayUrl = activeResult.kind === "image" ? privateImageUrl : "";
        if (displayUrl) window.open(displayUrl, "_blank", "noopener,noreferrer");
        return;
    }
    if (!user || auth.currentUser?.uid !== user.uid || !canGenerate) return;
    generationInFlight.current = true;
    setIsGenerating(true);
    setGenerationError("");
    let savingResult = false;
    let savedReference: string | undefined;
    try {
        const intent = createIntent({
            original: fileUrl, target: faceUrl,
            mediaType: isVideo ? "video" : isGif ? "gif" : "image",
            duration: isVideo ? videoDuration : null,
        });
        const requireCurrentSession = () => {
            if (auth.currentUser?.uid !== user.uid) throw new FaceSwapFlowError("A sessão mudou.");
        };
        const taskId = await startSwapTask(intent, fileUrl, {
            createMaterial: url => { requireCurrentSession(); return createMaterial(url); },
            getMaterial,
            createSwapTask: (...args) => { requireCurrentSession(); return createSwapTask(...args); },
        });
        const completed = await waitForFaceSwap(() => getSwapTask(taskId), "taskStatus", "o processamento do Face Swap");
        const result = await getSwapResult(taskId);
        const url = requireResultUrl(result?.file_url);
        if (!pageMounted.current || auth.currentUser !== user) throw new FaceSwapFlowError("A sessão mudou.");
        const kind = completed.videoUrl === url ? "video"
            : Array.isArray(completed.imageUrls) && completed.imageUrls.includes(url) ? "image" : "unknown";
        setPrivateImageUrl("");
        setPrivateResult({ owner: user, taskId, kind });
        savingResult = true;
        const saved = await saveFaceSwapResult(url, user.uid, kind);
        savedReference = saved.reference;
        if (pageMounted.current && auth.currentUser === user) {
            setPrivateResult({ owner: user, taskId, kind: saved.mediaType, reference: saved.reference });
        }
        if (saved.mediaType === "video") {
            const libraryItemId = await createLibraryVideo(user.uid, saved.reference, taskId, "face-swap");
            if (pageMounted.current && auth.currentUser === user) {
                setPrivateResult({ owner: user, taskId, kind: "video", reference: saved.reference, libraryItemId });
            }
        } else {
            await createLibraryImage(user.uid, saved.reference, "face-swap");
        }
    } catch (error) {
        if (pageMounted.current && auth.currentUser === user) setGenerationError(
            savingResult
                ? savedReference
                    ? "O Face Swap foi concluído e salvo, mas não foi possível confirmar seu registro na biblioteca. A referência foi preservada; nenhuma nova tarefa foi criada."
                    : "O Face Swap foi concluído, mas não foi possível salvar o resultado na biblioteca. Nenhuma nova tarefa foi criada automaticamente."
                : error instanceof FaceSwapFlowError
                    ? error.message
                    : swapOperationError(error) ?? `${getGenerationErrorMessage(error, "Não foi possível confirmar o Face Swap.")} Não houve reenvio automático.`,
        );
    } finally {
        generationInFlight.current = false;
        if (pageMounted.current) setIsGenerating(false);
    }
}

    return (
        <main className="face-swap">

            <div className="face-swap-container">

                <div className="face-swap-credits">
                    <Coins size={20} />

                    <span>
                        {formatCredits(credits)} {credits === 1 ? "crédito disponível" : "créditos disponíveis"}
                    </span>
                </div>

                <header className="face-swap-header">

                    <h1 className="face-swap-title">

                        Face <span>Swap</span>

                    </h1>

                    <p className="face-swap-description">

                        Faça upload de uma imagem ou vídeo, detecte rostos automaticamente e crie trocas de rosto realistas com inteligência artificial em poucos segundos.

                    </p>

                </header>

                {uploadAuthError && (
                    <div role="alert">
                        {uploadAuthError} {!authLoading && <Link to="/entrar">Entrar</Link>}
                    </div>
                )}

                <section className="face-swap-layout">

                    {/* =========================
                        WORKSPACE
                    ========================== */}

                    <div className="face-swap-workspace">

                        <div className="face-swap-inputs-card">

                            {
                                isGenerating ? (

                                    <div className="face-swap-generation-loading">

                                        <div className="face-swap-loading" />

                                    </div>

                                ) : activeResult ? (

                                    <div className="face-swap-generation-result">

                                        <button
                                            type="button"
                                            className="face-swap-back-button"
                                            onClick={() => {

                                                setPrivateResult(null);
                                                setPrivateImageUrl("");
                                                setGenerationError("");

                                                setFileUrl("");

                                                setFaceUrl("");

                                                setSelectedFile(null);

                                            }}
                                        >

                                            <ArrowLeft size={18} />

                                                <span>

                                                    Voltar

                                                </span>

                                        </button>

                                        {activeResult.kind === "image" && activeResult.reference ? (
                                            <PrivateFaceSwapImage value={activeResult.reference} uid={activeResult.owner.uid}
                                                onUrlChange={setPrivateImageUrl} />
                                        ) : activeResult.kind === "video" && activeResult.libraryItemId ? (
                                            <div className="face-swap-private-video">
                                                <PrivateLibraryVideo key={`${activeResult.owner.uid}:${activeResult.libraryItemId}`}
                                                    itemId={activeResult.libraryItemId} uid={activeResult.owner.uid} />
                                            </div>
                                        ) : (
                                            <p role="status">
                                                {activeResult.kind === "video"
                                                    ? "Vídeo concluído. A reprodução privada depende da confirmação do registro na biblioteca."
                                                    : activeResult.reference
                                                        ? "Resultado salvo; não foi possível confirmar seu tipo para exibição."
                                                        : "Resultado concluído. Consulte a biblioteca para verificar se foi salvo."}
                                                {" "}<Link to="/biblioteca">Abrir biblioteca</Link>
                                            </p>
                                        )}

                                    </div>

                                ) : (

                                    <div className="face-swap-inputs">

                        {/* Upload */}

                        <div className="face-swap-upload-card">

                            <div
                                className={`face-swap-upload-dropzone ${
                                    fileUrl ? "preview" : ""
                                }`}
                            >

                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept="image/*,video/*"
                                    style={{ display: "none" }}
                                    onChange={async (event) => {

                                        const file = event.target.files?.[0];
                                        event.target.value = "";

                                        if (!file) return;

                                        if (!canUpload()) return;

                                        setLoadingFile(true);

                                        try{

                                            setSelectedFile(file);

                                            if (file.type.startsWith("video/")) {

                                                const duration =
                                                    await getVideoDuration(file);

                                                setVideoDuration(duration);

                                            } else {

                                                setVideoDuration(0);

                                            }

                                            if (!canUpload()) return;
                                            const url = await uploadScopedFile(
                                                file,
                                                "face-swap",
                                                user?.uid
                                            );

                                            setFileUrl(url);

                                        }finally{

                                            setLoadingFile(false);

                                        }

                                    }}
                                />

                                {
                                    loadingFile ? (

                                        <div className="face-swap-loading" />

                                    ) : !fileUrl ? (

                                        <>

                                            <div className="face-swap-upload-icon">

                                                <svg
                                                    xmlns="http://www.w3.org/2000/svg"
                                                    width="42"
                                                    height="42"
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="1.8"
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                >
                                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                                    <polyline points="17 8 12 3 7 8"/>
                                                    <line x1="12" y1="3" x2="12" y2="15"/>
                                                </svg>

                                            </div>

                                            <h2 className="face-swap-upload-title">
                                                Faça upload do seu arquivo
                                            </h2>

                                            <p className="face-swap-upload-description">
                                                Arraste uma imagem ou vídeo para esta área ou clique no botão abaixo para selecionar um arquivo.
                                            </p>

                                            <span className="face-swap-upload-formats">
                                                PNG • JPG • JPEG • WEBP • MP4 • MOV
                                            </span>

                                            {
                                                selectedFile && (

                                                    <span className="face-swap-upload-selected">

                                                        {selectedFile.name}

                                                    </span>

                                                )
                                            }

                                            <>


                                                <button
                                                    className="face-swap-upload-button"
                                                    onClick={() => fileInputRef.current?.click()}
                                                >
                                                    Selecionar arquivo
                                                </button>
                                            </>

                                        </>

                                    ) : (

                                        <>

                                            <img
                                                src={filePreview}
                                                alt="Preview"
                                                className="face-swap-preview-image"
                                            />

                                            <button
                                                type="button"
                                                className="face-swap-upload-button"
                                                onClick={() => fileInputRef.current?.click()}
                                            >

                                                Trocar arquivo

                                            </button>

                                        </>

                                    )
                                }

                            </div>

                        </div>
                       
                        

                        {/* Faces */}

                        <div className="face-swap-faces-card">

                            <div className="face-swap-faces-header">

                                <div>

                                    <h2 className="face-swap-faces-title">

                                        Escolher rosto

                                    </h2>

                                    <p className="face-swap-faces-description">

                                        Adicione o rosto que será utilizado na troca. Você poderá selecionar uma imagem com o rosto da pessoa desejada.

                                    </p>

                                </div>

                            </div>

                            <div className="face-swap-faces-list">

                                {
                                    loadingFace ? (

                                        <div className="face-swap-loading" />

                                    ) : !faceUrl ? (

                                        <button
                                            type="button"
                                            className="face-swap-add-face"
                                            onClick={() => faceInputRef.current?.click()}
                                        >

                                            <input
                                                ref={faceInputRef}
                                                type="file"
                                                accept="image/*"
                                                className="face-swap-hidden-input"
                                                 onChange={async (event) => {

                                                    const file = event.target.files?.[0];

                                                    if (!file) return;

                                                    if (!canUpload()) return;

                                                    setLoadingFace(true);

                                                    try{

                                                        const url = await uploadScopedFile(
                                                            file,
                                                            "face-swap-faces",
                                                            user?.uid
                                                        );

                                                        setSelectedFace(file);
                                                        setFaceUrl(url);

                                                    }finally{

                                                        setLoadingFace(false);

                                                    }

                                                }}
                                            />

                                            <span className="face-swap-add-face-icon">

                                                <Plus size={30} />

                                            </span>

                                            <span className="face-swap-add-face-text">

                                                Adicionar rosto

                                            </span>

                                        </button>

                                    ) : (

                                        <div className="face-swap-face-preview">

                                            <img
                                                src={facePreview}
                                                alt="Rosto"
                                                className="face-swap-face-image"
                                            />

                                            <button
                                                type="button"
                                                className="face-swap-change-face"
                                                onClick={() => faceInputRef.current?.click()}
                                            >

                                                Trocar rosto

                                            </button>

                                            <input
                                                ref={faceInputRef}
                                                type="file"
                                                accept="image/*"
                                                className="face-swap-hidden-input"
                                                 onChange={async (event) => {

                                                    const file = event.target.files?.[0];

                                                    if (!file) return;

                                                    if (!canUpload()) return;

                                                    setLoadingFace(true);

                                                    try{

                                                        const url = await uploadScopedFile(
                                                            file,
                                                            "face-swap-faces",
                                                            user?.uid
                                                        );

                                                        setSelectedFace(file);
                                                        setFaceUrl(url);

                                                    }finally{

                                                        setLoadingFace(false);

                                                    }

                                                }}
                                            />

                                        </div>

                                    )
                                }

                            </div>

                        </div>

                                    </div>

                                    )
                                }

                            </div>


                            {/* Create */}

                            <button
                                type="button"
                                className="face-swap-create-button"
                                disabled={isGenerating || (activeResult ? !(activeResult.kind === "image" ? privateImageUrl : "") : !canGenerate)}
                                onClick={() => handleGenerateSwap()}
                            >

                                {
                                    activeResult
                                        ? activeResult.kind === "video" ? "Use os controles do vídeo" : "Baixar imagem"
                                        : isGenerating
                                            ? "Gerando Face Swap..."
                                            : "Criar Face Swap"
                                }

                            </button> 

                            {generationError && (
                                <p role="alert" className="face-swap-create-blocked-message">
                                    {generationError}
                                </p>
                            )}

                            {!isGenerating && generateBlockedMessage && (
                                isBlockedByInsufficientCredits ? (
                                    <Link
                                        to="/creditos"
                                        className="face-swap-credits-cta"
                                    >
                                        Você não possui créditos suficientes. Recarregue aqui
                                    </Link>
                                ) : (
                                    <p className="face-swap-create-blocked-message">
                                        {generateBlockedMessage}
                                    </p>
                                )
                            )}  

                    </div>

                   
              


                </section>

            </div>

        </main>
    );
}

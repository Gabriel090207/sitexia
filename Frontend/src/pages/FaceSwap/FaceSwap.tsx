import "./FaceSwap.css";
import {
    useEffect,
    useRef,
    useState,
} from "react";

import { useNavigate } from "react-router-dom";

import {
    uploadFile,
    uploadImageFromUrl,
} from "../../services/storage";

import { useAuth } from "../../contexts/AuthContext";

import {
    ArrowLeft,
    Plus,
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
    subscribeToLibraryImages,
} from "../../services/library";

export default function FaceSwap() {

const navigate = useNavigate();

const { user } = useAuth();

const [selectedFile, setSelectedFile] = useState<File | null>(null);
const [fileUrl, setFileUrl] = useState("");

const [loadingFile, setLoadingFile] = useState(false);

const [loadingFace, setLoadingFace] = useState(false);

const [faceUrl, setFaceUrl] =
    useState("");

const [resultUrl, setResultUrl] = useState("");

const fileInputRef = useRef<HTMLInputElement>(null);
const faceInputRef = useRef<HTMLInputElement>(null);

const [isGenerating, setIsGenerating] =
    useState(false);

const [libraryItems, setLibraryItems] =
    useState<string[]>([]);


useEffect(() => {

    if (!user) {

        setLibraryItems([]);

        return;

    }

    const unsubscribe =
        subscribeToLibraryImages(
            user.uid,
            (images) => {

                setLibraryItems(images);

            }
        );

    return () => {

        unsubscribe();

    };

}, [user]);


async function sleep(
    ms: number
) {
    return new Promise(
        (resolve) => setTimeout(resolve, ms)
    );
}

    return (
        <main className="face-swap">

            <div className="face-swap-container">

                <header className="face-swap-header">

                    <h1 className="face-swap-title">

                        Face <span>Swap</span>

                    </h1>

                    <p className="face-swap-description">

                        Faça upload de uma imagem ou vídeo, detecte rostos automaticamente e crie trocas de rosto realistas com inteligência artificial em poucos segundos.

                    </p>

                </header>

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

                                ) : resultUrl ? (

                                    <div className="face-swap-generation-result">

                                        <button
                                            type="button"
                                            className="face-swap-back-button"
                                            onClick={() => {

                                                setResultUrl("");

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

                                        <img
                                            src={resultUrl}
                                            alt="Resultado"
                                            className="face-swap-generation-image"
                                        />

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
                                                <input
                                                    ref={fileInputRef}
                                                    type="file"
                                                    accept="image/*,video/*"
                                                    style={{ display: "none" }}
                                                   onChange={async (event) => {

                                                        const file = event.target.files?.[0];

                                                        if (!file) return;

                                                        setLoadingFile(true);

                                                        try{

                                                            setSelectedFile(file);

                                                            const url = await uploadFile(
                                                                file,
                                                                "face-swap"
                                                            );

                                                            setFileUrl(url);

                                                        }finally{

                                                            setLoadingFile(false);

                                                        }

                                                    }}
                                                />

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
                                                src={fileUrl}
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

                                                    setLoadingFace(true);

                                                    try{

                                                        const url = await uploadFile(
                                                            file,
                                                            "face-swap-faces"
                                                        );

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
                                                src={faceUrl}
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

                                                    setLoadingFace(true);

                                                    try{

                                                        const url = await uploadFile(
                                                            file,
                                                            "face-swap-faces"
                                                        );

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
                                disabled={isGenerating}
                                onClick={async () => {

                                    if (resultUrl){

                                        window.open(resultUrl, "_blank");

                                        return;

                                    }

                                    setIsGenerating(true);

                                    const material = await createMaterial(
                                        fileUrl
                                    );

                                    console.log("Material criado:", material);

                                    let materialData = null;

                                    while (true) {

                                        await sleep(2000);

                                        materialData = await getMaterial(
                                            material.materialId
                                        );

                                        console.log(materialData);

                                        if (
                                            materialData.status === "SUCCEEDED"
                                        ) {

                                            break;

                                        }

                                    }

                                    console.log(
                                        "Material pronto:",
                                        materialData
                                    );

                                    const sourceFaceId =
                                        materialData.faces[0].id;

                                    console.log(
                                        "Face encontrada:",
                                        sourceFaceId
                                    );

                                    const task = await createSwapTask(
                                        materialData.materialId,
                                        sourceFaceId,
                                        faceUrl
                                    );

                                    console.log(
                                        "Task criada:",
                                        task
                                    );

                                    let taskData = null;

                                    while (true) {

                                        await sleep(2000);

                                        taskData = await getSwapTask(
                                            task.taskId
                                        );

                                        console.log(taskData);

                                        if (taskData.taskStatus === "SUCCEEDED") {

                                            const result = await getSwapResult(
                                                task.taskId
                                            );

                                            console.log(
                                                "Resultado:",
                                                result
                                            );

                                            setResultUrl(
                                                result.file_url
                                            );

                                            if (user) {

                                                const firebaseImageUrl =
                                                    await uploadImageFromUrl(
                                                        result.file_url,
                                                        `users/${user.uid}/swaps`
                                                    );

                                                await createLibraryImage(
                                                    user.uid,
                                                    firebaseImageUrl,
                                                    "face-swap"
                                                );

                                            }

                                            setIsGenerating(false);

                                            break;

                                        }

                                    }

                                }}
                            >

                                {
                                    resultUrl
                                        ? "Baixar imagem"
                                        : isGenerating
                                            ? "Gerando Face Swap..."
                                            : "Criar Face Swap"
                                }

                            </button>   

                    </div>

                   
              

                    {/* =========================
                        SIDEBAR
                    ========================== */}

                    <aside className="face-swap-sidebar">

                        <div className="face-swap-sidebar-card">

                            <div className="face-swap-library-header">

                                <h2 className="face-swap-library-title">

                                    Biblioteca

                                </h2>

                                <p className="face-swap-library-description">

                                    Utilize imagens enviadas anteriormente ou faça um novo upload.

                                </p>

                            </div>

                            <div className="face-swap-library-grid">

                                {
                                    Array.from({ length: 6 }).map((_, index) => {

                                        const imageUrl = libraryItems[index];

                                        return imageUrl ? (

                                            <button
                                                key={index}
                                                type="button"
                                                className="face-swap-library-item"
                                            >

                                                <img
                                                    src={imageUrl}
                                                    alt={`Geração ${index + 1}`}
                                                    className="face-swap-library-image"
                                                />

                                            </button>

                                        ) : (

                                            <div
                                                key={index}
                                                className="face-swap-library-item face-swap-library-placeholder"
                                            />

                                        );

                                    })
                                }

                            </div>

                            <button
                                className="face-swap-library-upload"
                                type="button"
                                onClick={() => navigate("/library")}
                            >
                                Ver biblioteca completa
                            </button>

                        </div>

                    </aside>

                </section>

            </div>

        </main>
    );
}
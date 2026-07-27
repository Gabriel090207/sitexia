import "./FaceSwap.css";

import {
    Plus,
} from "lucide-react";

export default function FaceSwap() {
    return (
        <main className="face-swap">

            <div className="face-swap-container">

                <header className="face-swap-header">

                    <h1 className="face-swap-title">

                        Face <span>Swap </span>

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

                        {/* Upload */}

                        <div className="face-swap-upload-card">

                            <div className="face-swap-upload-dropzone">

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

                                <button className="face-swap-upload-button">

                                    Selecionar arquivo

                                </button>

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

                                <button
                                    type="button"
                                    className="face-swap-add-face"
                                >

                                    <span className="face-swap-add-face-icon">

                                        <Plus size={30} />

                                    </span>

                                    <span className="face-swap-add-face-text">

                                        Adicionar rosto

                                    </span>

                                </button>

                            </div>

                        </div>

                        {/* Create */}

                      

                            <button
                                type="button"
                                className="face-swap-create-button"
                            >

                                Criar Face Swap

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

                                <button
                                    type="button"
                                    className="face-swap-library-item"
                                >

                                </button>

                                <button
                                    type="button"
                                    className="face-swap-library-item"
                                >

                                </button>

                                <button
                                    type="button"
                                    className="face-swap-library-item"
                                >

                                </button>

                                <button
                                    type="button"
                                    className="face-swap-library-item"
                                >

                                </button>

                                <button
                                    type="button"
                                    className="face-swap-library-item"
                                >

                                </button>

                                <button
                                    type="button"
                                    className="face-swap-library-item"
                                >

                                </button>


                                <button
                                    type="button"
                                    className="face-swap-library-item"
                                >

                                </button>

                                <button
                                    type="button"
                                    className="face-swap-library-item"
                                >

                                </button>

                                <button
                                    type="button"
                                    className="face-swap-library-item"
                                >

                                </button>

                                <button
                                    type="button"
                                    className="face-swap-library-item"
                                >

                                </button>

                                

                            </div>

                            <button
                                type="button"
                                className="face-swap-library-upload"
                            >

                                Enviar imagem

                            </button>

                        </div>

                    </aside>

                </section>

            </div>

        </main>
    );
}
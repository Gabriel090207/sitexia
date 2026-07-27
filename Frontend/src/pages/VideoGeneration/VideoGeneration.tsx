import "./VideoGeneration.css";

import {
    ImagePlus,
    Clock3,
    Images,
    MessageSquareText,
} from "lucide-react";

export default function VideoGeneration() {

    return (

        <main className="video-generation">

            <div className="video-generation-container">

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

                    <div className="video-generation-modes">

                        <button className="video-generation-mode video-generation-mode-active">

                            <ImagePlus size={22} />

                            <span>

                                Imagem para Vídeo

                            </span>

                        </button>

                        <button className="video-generation-mode">

                            <Clock3 size={22} />

                            <span>

                                Estender Vídeo

                            </span>

                        </button>

                        <button className="video-generation-mode">

                            <Images size={22} />

                            <span>

                                Referência para Vídeo

                            </span>

                            <small>

                                Novo

                            </small>

                        </button>

                        <button className="video-generation-mode">

                            <MessageSquareText size={22} />

                            <span>

                                Texto para Vídeo

                            </span>

                        </button>

                    </div>

                    {/* UPLOAD */}

                    <div className="video-generation-upload">

                        <div className="video-generation-upload-content">

                            <div className="video-generation-upload-icon">

                                <ImagePlus size={42} />

                            </div>

                            <h2 className="video-generation-upload-title">

                                Envie sua imagem

                            </h2>

                            <p className="video-generation-upload-description">

                                Arraste uma imagem para esta área ou clique no botão abaixo para selecionar um arquivo.

                            </p>

                            <span className="video-generation-upload-formats">

                                PNG • JPG • JPEG • WEBP

                            </span>

                            <button
                                className="video-generation-upload-button"
                                type="button"
                            >

                                Selecionar imagem

                            </button>

                        </div>

                    </div>

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
                        />

                    </div>

                   

                    

                </section>

                {/* BUTTON */}

                    <button className="video-generation-button">

                        Gerar Vídeo

                    </button>

            </div>

        </main>

    );

}
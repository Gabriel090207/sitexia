import {
    Clapperboard,
    Image,
    ScanFace,
    Video,
    Sparkles,
} from "lucide-react";

import ToolCard from "./ToolCard/ToolCard";

import "./AITools.css";

function AITools() {
    return (
        <section className="ai-tools">

            <div className="ai-tools-container">

                <div className="ai-tools-header">

                    <span className="ai-tools-badge">

                        <Sparkles
                            size={16}
                            strokeWidth={2}
                            className="ai-tools-badge-icon"
                        />

                        <span className="ai-tools-badge-text">
                            Nova Geração de Ferramentas de IA
                        </span>

                    </span>

                    <h2 className="ai-tools-title">
                        Tudo o que você precisa
                        <br />
                        <span className="ai-tools-title-highlight">
                            em uma única plataforma.
                        </span>
                    </h2>

                    <p className="ai-tools-description">
                        Crie conteúdos profissionais utilizando nossas ferramentas de inteligência
                        artificial para Face Swap, vídeos e geração de imagens em um só lugar.
                    </p>

                </div>

                <div className="ai-tools-grid">

                    <ToolCard
                        icon={<ScanFace size={42} strokeWidth={1.8} />}
                        title="Face Swap"
                        description="Troque rostos em fotos com realismo impressionante utilizando IA."
                        link="/face-swap"
                    />

                    <ToolCard
                        icon={<Clapperboard size={42} strokeWidth={1.8} />}
                        title="Video Swap"
                        description="Substitua rostos em vídeos com rapidez e alta qualidade."
                        link="/video-generation"
                    />

                    <ToolCard
                        icon={<Video size={42} strokeWidth={1.8} />}
                        title="AI Video"
                        description="Crie vídeos a partir de texto ou imagens usando inteligência artificial."
                        link="/video-generation"
                    />

                    <ToolCard
                        icon={<Image size={42} strokeWidth={1.8} />}
                        title="Image Generator"
                        description="Gere imagens únicas em segundos utilizando modelos avançados de IA."
                        link="/image-generation"
                    />

                </div>

            </div>

        </section>
    );
}

export default AITools;
import {
    ArrowRight,
    Play,
} from "lucide-react";

import "./Hero.css";

import HeroPreviewVideo from "../../assets/videos/hero-preview.mp4";

function Hero() {
    return (
        <section className="hero">

            <div className="hero-container">

                <div className="hero-left">

                    

                    <h1 className="hero-title">

                        Troque rostos e
                        

                        crie vídeos.
                        

                        <span className="hero-title-highlight">
                            Gere infinitas
                           
                            possibilidades.
                        </span>

                    </h1>

                    <p className="hero-description">
                        Plataforma completa de IA para Face Swap, geração de Vídeos e criaçãode conteúdo de alta qualidade em
                    </p>

                    <div className="hero-buttons">

                        <button className="hero-primary-button">

                            <span className="hero-primary-button-text">
                                Começar Agora
                            </span>

                            <ArrowRight
                                size={18}
                                className="hero-primary-button-icon"
                            />

                        </button>

                        <button className="hero-secondary-button">

                            <Play
                                size={18}
                                className="hero-secondary-button-icon"
                            />

                            <span className="hero-secondary-button-text">
                                Ver demonstração
                            </span>

                        </button>

                    </div>

                    <div className="hero-features">

                    </div>

                </div>

                <div className="hero-right">

                    <div className="hero-preview-glow"></div>

                    <div className="hero-preview">

                        <video
                            className="hero-preview-video"
                            autoPlay
                            muted
                            loop
                            playsInline
                        >
                            <source
                                src={HeroPreviewVideo}
                                type="video/mp4"
                            />
                        </video>

                    </div>

                </div>

            </div>

        </section>
    );
}

export default Hero;
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

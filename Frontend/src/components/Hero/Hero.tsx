import "./Hero.css";

import HeroImage from "../../assets/images/hero.webp";

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

                        <img
                            className="hero-preview-video"
                            src={HeroImage}
                            alt="Prévia dos recursos da plataforma"
                        />

                    </div>

                </div>

            </div>

        </section>
    );
}

export default Hero;

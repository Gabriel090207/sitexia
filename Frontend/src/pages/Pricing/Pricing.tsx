import "./Pricing.css";

import { Star } from "lucide-react";

const Pricing = () => {

    return (

        <section className="pricing">

            <div className="pricing-container">

                <div className="pricing-header">

                    <h1 className="pricing-title">
                        Escolha seu <span>Plano</span>
                    </h1>

                    <p className="pricing-description">
                        Compre créditos para utilizar todas as ferramentas de IA da Xia.
                        Escolha o plano ideal para sua necessidade e gere imagens, vídeos e face swaps com rapidez.
                    </p>

                </div>

                <div className="pricing-grid">

                    {/* STARTER */}

                    <div className="pricing-card">

                        <span className="pricing-plan">
                            Starter
                        </span>

                        <h2 className="pricing-price">
                            R$ 129,90
                        </h2>

                        <p className="pricing-credits">
                            12 Créditos
                        </p>

                        <ul className="pricing-features">

                            <li>Face Swap</li>

                            <li>Image Generation</li>

                            <li>Video Generation</li>

                            <li>Suporte padrão</li>

                        </ul>

                        <button className="pricing-button">

                            Comprar Agora

                        </button>

                    </div>

                    {/* PRO */}

                    <div className="pricing-card pricing-featured">

                        <span className="pricing-badge">

                            <Star size={14} />

                            Mais Popular

                        </span>

                        <span className="pricing-plan">

                            Pro

                        </span>

                        <h2 className="pricing-price">

                            R$ 599,90

                        </h2>

                        <p className="pricing-credits">

                            80 Créditos

                        </p>

                        <ul className="pricing-features">

                            <li>Face Swap</li>

                            <li>Image Generation</li>

                            <li>Video Generation</li>

                            <li>Prioridade na fila</li>

                            <li>Suporte prioritário</li>

                        </ul>

                        <button className="pricing-button">

                            Comprar Agora

                        </button>

                    </div>

                    {/* ENTERPRISE */}

                    <div className="pricing-card">

                        <span className="pricing-plan">

                            Enterprise

                        </span>

                        <h2 className="pricing-price">

                            R$ 2.599,90

                        </h2>

                        <p className="pricing-credits">

                            350 Créditos

                        </p>

                        <ul className="pricing-features">

                            <li>Face Swap</li>

                            <li>Image Generation</li>

                            <li>Video Generation</li>

                            <li>Máxima prioridade</li>

                            <li>Suporte VIP</li>

                        </ul>

                        <button className="pricing-button">

                            Comprar Agora

                        </button>

                    </div>

                </div>

            </div>

        </section>

    );

};

export default Pricing;
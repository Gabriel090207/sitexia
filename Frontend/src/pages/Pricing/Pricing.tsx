import "./Pricing.css";

import {
    PLANS,
    formatPlanPrice,
} from "../../config/plans";

import {
    Star,
    Check,
} from "lucide-react";

import { useNavigate } from "react-router-dom";

const Pricing = () => {

const navigate = useNavigate();

    return (

        <section className="pricing">

            <div className="pricing-container">

                <div className="pricing-header">

                    <h1 className="pricing-title">
                        Escolha seu <span>pacote de créditos</span>
                    </h1>

                    <p className="pricing-description">
                        Compre créditos para utilizar todas as ferramentas de IA da Xia.
                        Escolha a quantidade de créditos ideal para sua necessidade.
                        Gere imagens, vídeos e face swaps com rapidez.
                    </p>

                </div>

                <div className="pricing-grid">

                    {/* STARTER */}

                    <div className="pricing-card">

                        <span className="pricing-plan">
                            Starter
                        </span>

                        <h2 className="pricing-price">
                            {formatPlanPrice(
                                PLANS.find(
                                    (plan) => plan.id === "starter"
                                )!.price
                            )}
                        </h2>

                        <p className="pricing-credits">
                            {
                                PLANS.find(
                                    (plan) => plan.id === "starter"
                                )!.credits
                            } Créditos
                        </p>

                        <ul className="pricing-features">

                            <li><Check size={16} /> Face Swap</li>

                            <li><Check size={16} /> Image Generation</li>

                            <li><Check size={16} /> Video Generation</li>

                        </ul>

                        <button
                            className="pricing-button"
                            onClick={() => {
                                navigate("/checkout", {
                                    state: {
                                        plan: PLANS.find(
                                            (plan) => plan.id === "starter"
                                        )!,
                                    },
                                });
                            }}
                        >
                            Comprar créditos
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
                            {formatPlanPrice(
                                PLANS.find(
                                    (plan) => plan.id === "pro"
                                )!.price
                            )}
                        </h2>

                        <p className="pricing-credits">
                            {
                                PLANS.find(
                                    (plan) => plan.id === "pro"
                                )!.credits
                            } Créditos
                        </p>

                        <ul className="pricing-features">

                            <li><Check size={16} /> Face Swap</li>

                            <li><Check size={16} /> Image Generation</li>

                            <li><Check size={16} /> Video Generation</li>

                        </ul>

                       <button
                            className="pricing-button"
                            onClick={() => {
                                navigate("/checkout", {
                                    state: {
                                        plan: PLANS.find(
                                            (plan) => plan.id === "pro"
                                        )!,
                                    },
                                });
                            }}
                        >
                            Comprar créditos
                        </button>

                    </div>

                    {/* ENTERPRISE */}

                    <div className="pricing-card">

                        <span className="pricing-plan">

                            Enterprise

                        </span>

                        <h2 className="pricing-price">
                            {formatPlanPrice(
                                PLANS.find(
                                    (plan) => plan.id === "enterprise"
                                )!.price
                            )}
                        </h2>

                        <p className="pricing-credits">
                            {
                                PLANS.find(
                                    (plan) => plan.id === "enterprise"
                                )!.credits
                            } Créditos
                        </p>

                        <ul className="pricing-features">

                            <li><Check size={16} /> Face Swap</li>

                            <li><Check size={16} /> Image Generation</li>

                            <li><Check size={16} /> Video Generation</li>

                        </ul>

                        <button
                            className="pricing-button"
                            onClick={() => {
                                navigate("/checkout", {
                                    state: {
                                        plan: PLANS.find(
                                            (plan) => plan.id === "enterprise"
                                        )!,
                                    },
                                });
                            }}
                        >
                            Comprar créditos
                        </button>

                    </div>

                </div>


                <section className="pricing-credit-costs">

                    <div className="pricing-credit-costs-header">

                        <h2>
                            Como seus <span>créditos</span> são utilizados
                        </h2>

                        <p>
                            Consulte o custo de cada geração antes de utilizar
                            as ferramentas da Xia.
                        </p>

                    </div>

                    <div className="pricing-credit-table-wrapper">

                        <table className="pricing-credit-table">

                            <thead>
                                <tr>
                                    <th>Ferramenta</th>
                                    <th>Geração</th>
                                    <th>Custo</th>
                                </tr>
                            </thead>

                            <tbody>

                                <tr>
                                    <td>Image Generation</td>
                                    <td>1 imagem</td>
                                    <td>
                                        <strong>0,2</strong> crédito
                                    </td>
                                </tr>

                                <tr>
                                    <td>Image Generation</td>
                                    <td>4 imagens</td>
                                    <td>
                                        <strong>0,8</strong> crédito
                                    </td>
                                </tr>

                                <tr>
                                    <td>Image Generation</td>
                                    <td>9 imagens</td>
                                    <td>
                                        <strong>1,8</strong> créditos
                                    </td>
                                </tr>

                                <tr>
                                    <td>Video Generation</td>
                                    <td>5 segundos</td>
                                    <td>
                                        <strong>1,2</strong> créditos
                                    </td>
                                </tr>

                                <tr>
                                    <td>Video Generation</td>
                                    <td>10 segundos</td>
                                    <td>
                                        <strong>2,4</strong> créditos
                                    </td>
                                </tr>

                                <tr>
                                    <td>Video Generation</td>
                                    <td>15 segundos</td>
                                    <td>
                                        <strong>3,6</strong> créditos
                                    </td>
                                </tr>

                                <tr>
                                    <td>Reference to Video</td>
                                    <td>5 segundos</td>
                                    <td>
                                        <strong>2</strong> créditos
                                    </td>
                                </tr>

                                <tr>
                                    <td>Reference to Video</td>
                                    <td>10 segundos</td>
                                    <td>
                                        <strong>4</strong> créditos
                                    </td>
                                </tr>

                                <tr>
                                    <td>Reference to Video</td>
                                    <td>15 segundos</td>
                                    <td>
                                        <strong>6</strong> créditos
                                    </td>
                                </tr>

                            </tbody>

                        </table>

                    </div>

                </section>

            </div>

        </section>

    );

};

export default Pricing;

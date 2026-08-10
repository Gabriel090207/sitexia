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

import {
    useEffect,
    useState,
} from "react";

import {
    doc,
    getDoc,
} from "firebase/firestore";

import { useAuth } from "../../contexts/AuthContext";

import db from "../../firebase/firestore";

const Pricing = () => {

const navigate = useNavigate();

const { user } = useAuth();

const [currentPlan, setCurrentPlan] =
    useState("free");

useEffect(() => {

    async function loadUserPlan() {

        if (!user) {
            setCurrentPlan("free");
            return;
        }

        const userRef = doc(
            db,
            "users",
            user.uid
        );

        const snapshot = await getDoc(userRef);

        if (snapshot.exists()) {

            const userData = snapshot.data();

            setCurrentPlan(
                userData.plan || "free"
            );

        }

    }

    loadUserPlan();

}, [user]);


const isStarterCurrent =
    currentPlan === "starter";

const isProCurrent =
    currentPlan === "pro";

const isEnterpriseCurrent =
    currentPlan === "enterprise";

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

                    <div
                        className={
                            isStarterCurrent
                                ? "pricing-card pricing-card-current"
                                : "pricing-card"
                        }
                    >

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

                            <li><Check size={16} /> Suporte padrão</li>

                        </ul>

                        <button
                            className={
                                isStarterCurrent
                                    ? "pricing-button pricing-button-current"
                                    : "pricing-button"
                            }
                            disabled={isStarterCurrent}
                            onClick={() => {

                                if (isStarterCurrent) {
                                    return;
                                }

                                navigate("/checkout", {
                                    state: {
                                        plan: PLANS.find(
                                            (plan) => plan.id === "starter"
                                        )!,
                                    },
                                });
                            }}
                        >
                            {isStarterCurrent
                                ? "Plano Atual"
                                : "Comprar Agora"}
                        </button>

                    </div>

                    {/* PRO */}

                    <div
                        className={
                            isProCurrent
                                ? "pricing-card pricing-featured pricing-card-current"
                                : "pricing-card pricing-featured"
                        }
                    >

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

                            <li><Check size={16} /> Prioridade na fila</li>

                            <li><Check size={16} /> Suporte prioritário</li>

                        </ul>

                       <button
                            className={
                                isProCurrent
                                    ? "pricing-button pricing-button-current"
                                    : "pricing-button"
                            }
                            disabled={isProCurrent}
                            onClick={() => {

                                if (isProCurrent) {
                                    return;
                                }

                                navigate("/checkout", {
                                    state: {
                                        plan: PLANS.find(
                                            (plan) => plan.id === "pro"
                                        )!,
                                    },
                                });
                            }}
                        >
                            {isProCurrent
                                ? "Plano Atual"
                                : "Comprar Agora"}
                        </button>

                    </div>

                    {/* ENTERPRISE */}

                    <div
                        className={
                            isEnterpriseCurrent
                                ? "pricing-card pricing-card-current"
                                : "pricing-card"
                        }
                    >

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

                            <li><Check size={16} /> Máxima prioridade</li>

                            <li><Check size={16} /> Suporte VIP</li>

                        </ul>

                        <button
                            className={
                                isEnterpriseCurrent
                                    ? "pricing-button pricing-button-current"
                                    : "pricing-button"
                            }
                            disabled={isEnterpriseCurrent}
                            onClick={() => {

                                if (isEnterpriseCurrent) {
                                    return;
                                }

                                navigate("/checkout", {
                                    state: {
                                        plan: PLANS.find(
                                            (plan) => plan.id === "enterprise"
                                        )!,
                                    },
                                });
                            }}
                        >
                            {isEnterpriseCurrent
                                ? "Plano Atual"
                                : "Comprar Agora"}
                        </button>

                    </div>

                </div>

            </div>

        </section>

    );

};

export default Pricing;
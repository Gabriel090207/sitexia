import "./Checkout.css";
import { useState } from "react";

import { useLocation } from "react-router-dom";

import { createSubscription } from "../../api/subscription";

export default function Checkout() {

const location = useLocation();

const plan = location.state?.plan;

const [cardHolder, setCardHolder] = useState("");

const [email, setEmail] = useState("");

const [cpf, setCpf] = useState("");

const [cardHolderName, setCardHolderName] = useState("");

const [cardNumber, setCardNumber] = useState("");

const [cardExpiry, setCardExpiry] = useState("");

const [cardCvv, setCardCvv] = useState("");

const mp = new window.MercadoPago(
    import.meta.env.VITE_MERCADO_PAGO_PUBLIC_KEY
);

const [checkoutStep, setCheckoutStep] = useState<
    "checkout" | "loading" | "success" | "create-account" | "error"
>("checkout");

const [subscriptionResponse, setSubscriptionResponse] = useState<any>(null);

async function generateCardToken() {

    setCheckoutStep("loading");

    try {

        const [month, year] = cardExpiry.split("/");

        const tokenResponse = await mp.createCardToken({

            cardNumber:
                cardNumber.replace(/\s/g, ""),

            cardholderName:
                cardHolderName,

            identificationType:
                "CPF",

            identificationNumber:
                cpf.replace(/\D/g, ""),

            securityCode:
                cardCvv,

            cardExpirationMonth:
                month,

            cardExpirationYear:
                `20${year}`,

        });

        const response = await createSubscription({

            user_id: "",

            token: tokenResponse.id,

            email,

            cpf: cpf.replace(/\D/g, ""),

            amount: plan.price,

            card_holder: cardHolder,

        });

        setSubscriptionResponse(response);


        setCheckoutStep("success");

    } catch (error) {

        console.error(error);

        setCheckoutStep("error");

    }

}

function formatCPF(value: string) {

    return value

        .replace(/\D/g, "")

        .slice(0, 11)

        .replace(/(\d{3})(\d)/, "$1.$2")

        .replace(/(\d{3})(\d)/, "$1.$2")

        .replace(/(\d{3})(\d{1,2})$/, "$1-$2");

}

function formatCardHolder(value: string) {

    return value

        .replace(/[^a-zA-ZÀ-ÿ\s]/g, "")

        .replace(/\s+/g, " ")

        .trimStart();

}

if (checkoutStep === "loading") {

    return (

        <main className="checkout">

            <div className="checkout-loading">

                <div className="checkout-loading-spinner" />

                <h2>Processando assinatura...</h2>

                <p>

                    Estamos processando seu pagamento.

                    Não feche esta página.

                </p>

            </div>

        </main>

    );

}

if (checkoutStep === "error") {

    return (

        <main className="checkout">

            <div className="checkout-error">

                <h2>

                    Não foi possível concluir sua assinatura

                </h2>

                <p>

                    Ocorreu um erro durante o processamento do pagamento.

                </p>

                <button
                    className="checkout-submit-button"
                    onClick={() => setCheckoutStep("checkout")}
                >

                    Tentar novamente

                </button>

            </div>

        </main>

    );

}

if (checkoutStep === "success") {

    return (

        <main className="checkout">

            <div className="checkout-success">

                <h2>

                    Assinatura ativada!

                </h2>

                <p>

                    Seu pagamento foi aprovado com sucesso.

                </p>

                <pre>

                    {JSON.stringify(subscriptionResponse, null, 2)}

                </pre>

                <button
                    className="checkout-submit-button"
                >

                    Continuar

                </button>

            </div>

        </main>

    );

}


    return (

        <main className="checkout">

            <div className="checkout-container">

                <header className="checkout-header">

                    <h1 className="checkout-title">

                        Finalizar <span>Assinatura</span>

                    </h1>

                    <p className="checkout-description">

                        Complete seus dados para ativar sua assinatura da Xia através de um pagamento seguro com Mercado Pago.

                    </p>

                </header>


                <section className="checkout-layout">

                    <div className="checkout-form-card">

                        <h2 className="checkout-card-title">

                            Dados do pagamento

                        </h2>

                        <p className="checkout-card-description">

                            Informe os dados do titular e do cartão para ativar sua assinatura.

                        </p>

                        <div className="checkout-form">

                            <div className="checkout-field">

                                <label>Nome completo</label>

                                <input
                                    type="text"
                                    placeholder="Digite o nome do titular"
                                    value={cardHolder}
                                    onChange={(e) => setCardHolder(formatCardHolder(e.target.value.toUpperCase()))}
                                />

                            </div>

                            <div className="checkout-field">

                                <label>E-mail</label>

                                <input
                                    type="email"
                                    placeholder="Digite seu e-mail"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                />

                            </div>

                            <div className="checkout-field">

                                <label>CPF</label>

                                    <input
                                        type="text"
                                        placeholder="000.000.000-00"
                                        value={cpf}
                                        onChange={(e) => setCpf(formatCPF(e.target.value))}
                                    />

                            </div>


                            <h3 className="checkout-section-title">

                                Dados do cartão

                            </h3>

                            <div className="checkout-field">

                                <label>Número do cartão</label>

                                <input
                                    type="text"
                                    placeholder="1234 5678 9012 3456"
                                    value={cardNumber}
                                    onChange={(e) => {

                                        const value =
                                            e.target.value
                                                .replace(/\D/g, "")
                                                .slice(0, 16);

                                        const formatted =
                                            value.replace(
                                                /(\d{4})(?=\d)/g,
                                                "$1 "
                                            );

                                        setCardNumber(formatted);

                                    }}
                                />

                            </div>

                            <div className="checkout-field">

                                <label>Nome impresso no cartão</label>

                                <input
                                    type="text"
                                    placeholder="Nome igual ao cartão"
                                    value={cardHolderName}
                                    onChange={(e) => setCardHolderName(formatCardHolder(e.target.value.toUpperCase()))}
                                />

                            </div>

                            <div className="checkout-field-row">

                                 <div className="checkout-field">

                                    <label>Validade</label>

                                    <input
                                        type="text"
                                        placeholder="MM/AA"
                                        value={cardExpiry}
                                        onChange={(e) => {

                                            const value =
                                                e.target.value
                                                    .replace(/\D/g, "")
                                                    .slice(0, 4);

                                            let formatted = value;

                                            if (value.length >= 3) {

                                                formatted =
                                                    value.slice(0, 2) +
                                                    "/" +
                                                    value.slice(2);

                                            }

                                            setCardExpiry(formatted);

                                        }}
                                    />

                                </div>

                                <div className="checkout-field">

                                    <label>CVV</label>

                                    <input
                                        type="text"
                                        placeholder="123"
                                        value={cardCvv}
                                        onChange={(e) => {

                                            const value =
                                                e.target.value
                                                    .replace(/\D/g, "")
                                                    .slice(0, 3);

                                            setCardCvv(value);

                                        }}
                                    />

                                </div>

                            </div>


                            <button
                                type="button"
                                className="checkout-submit-button"
                                onClick={generateCardToken}
                            >
                                Finalizar assinatura
                            </button>

                        </div>

                    </div>

                   <aside className="checkout-summary-card">

                        <h2 className="checkout-card-title">

                            Resumo da assinatura

                        </h2>

                        <p className="checkout-card-description">

                            Confira as informações antes de finalizar o pagamento.

                        </p>


                        <div className="checkout-summary">

                            <div className="checkout-summary-row">
                                <span>Plano</span>
                                <strong>{plan?.name}</strong>
                            </div>

                            <div className="checkout-summary-row">
                                <span>Créditos</span>
                                <strong>{plan?.credits}</strong>
                            </div>

                            <div className="checkout-summary-divider" />

                            <div className="checkout-summary-total">
                                <span>Total</span>
                                <strong>
                                    {plan?.price.toLocaleString("pt-BR", {
                                        style: "currency",
                                        currency: "BRL",
                                    })}
                                </strong>
                            </div>

                        </div>

                    </aside>

                </section>

            </div>

        </main>

    );

}
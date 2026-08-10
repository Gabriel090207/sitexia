import "./Checkout.css";
import {
    useRef,
    useState,
} from "react";

import {
    Navigate,
    useLocation,
    useNavigate
} from "react-router-dom";

import {
    Check,
    Eye,
    EyeOff,
    LockKeyhole,
    X
} from "lucide-react";

import {
    createSubscription,
    linkSubscription
} from "../../api/subscription";

import {
    createUserWithEmailAndPassword,
    signInWithCustomToken,
} from "firebase/auth";

import { FirebaseError } from "firebase/app";

import auth from "../../firebase/auth";

import { createUserDocument } from "../../firebase/users";

type SubscriptionResponse = {

    user_exists: boolean;

    custom_token?: string;

    subscription_id?: string;

};

function isValidCpf(cpf: string) {

    const numbers =
        cpf.replace(/\D/g, "");

    if (numbers.length !== 11) {
        return false;
    }

    if (/^(\d)\1{10}$/.test(numbers)) {
        return false;
    }

    const calculateDigit = (
        base: string,
        factor: number
    ) => {

        let total = 0;

        for (const digit of base) {

            total +=
                Number(digit) * factor;

            factor--;

        }

        const remainder =
            (total * 10) % 11;

        return remainder === 10
            ? 0
            : remainder;

    };

    const firstDigit =
        calculateDigit(
            numbers.slice(0, 9),
            10
        );

    if (
        firstDigit !==
        Number(numbers[9])
    ) {
        return false;
    }

    const secondDigit =
        calculateDigit(
            numbers.slice(0, 10),
            11
        );

    return (
        secondDigit ===
        Number(numbers[10])
    );

}

export default function Checkout() {

const location = useLocation();

const navigate = useNavigate();

const plan = location.state?.plan;

const [cardHolder, setCardHolder] = useState("");

const [email, setEmail] = useState("");

const [cpf, setCpf] = useState("");

const [cardHolderName, setCardHolderName] = useState("");

const [cardNumber, setCardNumber] = useState("");

const [cardExpiry, setCardExpiry] = useState("");

const [cardCvv, setCardCvv] = useState("");

const [password, setPassword] = useState("");

const [confirmPassword, setConfirmPassword] = useState("");

const [showPassword, setShowPassword] = useState(false);

const [showConfirmPassword, setShowConfirmPassword] = useState(false);

const [passwordError, setPasswordError] = useState("");

const [confirmPasswordError, setConfirmPasswordError] = useState("");

const [checkoutError, setCheckoutError] = useState("");

const [creatingAccount, setCreatingAccount] = useState(false);

const [processingPayment, setProcessingPayment] =
    useState(false);

const [subscriptionResponse, setSubscriptionResponse] =
    useState<SubscriptionResponse | null>(null);

const mercadoPagoPublicKey =
    import.meta.env.VITE_MERCADO_PAGO_PUBLIC_KEY;

if (!mercadoPagoPublicKey) {

    throw new Error(
        "VITE_MERCADO_PAGO_PUBLIC_KEY não configurada."
    );

}

if (!window.MercadoPago) {

    throw new Error(
        "SDK do Mercado Pago não carregado."
    );

}

const mpRef = useRef(
    new window.MercadoPago(
        mercadoPagoPublicKey
    )
);

const mp = mpRef.current;

const [checkoutStep, setCheckoutStep] = useState<
    | "checkout"
    | "loading"
    | "create-account"
    | "success"
    | "error"
>("checkout");

if (!plan) {

    return (
        <Navigate
            to="/pricing"
            replace
        />
    );

}

async function generateCardToken() {

    if (
        !cardHolder.trim() ||
        !email.trim() ||
        !cpf.trim() ||
        !cardNumber.trim() ||
        !cardHolderName.trim() ||
        !cardExpiry.trim() ||
        !cardCvv.trim()
    ) {

        setCheckoutError(
            "Preencha todos os campos para continuar."
        );

        return;

    }

    setCheckoutError("");

    const customerName =
        cardHolder.trim();

    if (customerName.length < 3) {

        setCheckoutError(
            "Digite seu nome completo."
        );

        return;

    }

    const emailRegex =
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(email.trim())) {

        setCheckoutError(
            "Digite um e-mail válido."
        );

        return;

    }

    if (!isValidCpf(cpf)) {

        setCheckoutError(
            "Digite um CPF válido."
        );

        return;

    }

    const cardNumbers =
        cardNumber.replace(/\D/g, "");

    if (cardNumbers.length !== 16) {

        setCheckoutError(
            "Digite um número de cartão válido."
        );

        return;

    }

    const holderName =
        cardHolderName.trim();

    if (holderName.length < 3) {

        setCheckoutError(
            "Digite o nome do titular do cartão."
        );

        return;

    }

    const [expiryMonth, expiryYear] =
        cardExpiry.split("/");

    const monthNumber =
        Number(expiryMonth);

    const yearNumber =
        Number(`20${expiryYear}`);

    if (
        !expiryMonth ||
        !expiryYear ||
        expiryMonth.length !== 2 ||
        expiryYear.length !== 2 ||
        monthNumber < 1 ||
        monthNumber > 12
    ) {

        setCheckoutError(
            "Digite uma validade de cartão válida."
        );

        return;

    }

    const currentDate = new Date();

    const currentMonth =
        currentDate.getMonth() + 1;

    const currentYear =
        currentDate.getFullYear();

    if (
        yearNumber < currentYear ||
        (
            yearNumber === currentYear &&
            monthNumber < currentMonth
        )
    ) {

        setCheckoutError(
            "Este cartão está vencido."
        );

        return;

    }

    const cvvNumbers =
        cardCvv.replace(/\D/g, "");

    if (cvvNumbers.length !== 3) {

        setCheckoutError(
            "Digite um CVV válido."
        );

        return;

    }

    if (processingPayment) {
        return;
    }

    setProcessingPayment(true);

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

        if (!tokenResponse?.id) {

            throw new Error(
                "Token do cartão não foi gerado."
            );

        }

        const response = await createSubscription({

            user_id: "",

            token: tokenResponse.id,

            email,

            cpf: cpf.replace(/\D/g, ""),

            amount: plan.price,

            card_holder: cardHolder,

            plan_id: plan.id,

            plan_name: plan.name,

            credits: plan.credits,

        });


        if (
            !response ||
            typeof response.user_exists !== "boolean"
        ) {

            throw new Error(
                "Resposta inválida ao criar assinatura."
            );

        }

        setSubscriptionResponse(response);


        if (response.user_exists) {

            if (!response.custom_token) {

                throw new Error(
                    "Token de autenticação não recebido."
                );

            }

            await signInWithCustomToken(
                auth,
                response.custom_token
            );

            setCheckoutStep("success");

        } else {

            if (!response.subscription_id) {

                throw new Error(
                    "Assinatura não retornada pelo servidor."
                );

            }

            setCheckoutStep("create-account");

        }

    } catch {

        setProcessingPayment(false);

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

                <div className="checkout-error-icon">

                    <X
                        size={38}
                        strokeWidth={2.5}
                    />

                </div>

                <h2>

                    Não foi possível concluir sua assinatura

                </h2>

                <p>

                    Ocorreu um erro durante o processamento do pagamento.

                </p>

                <button
                    className="checkout-submit-button"
                    onClick={() => {

                        setCheckoutError("");

                        setCheckoutStep("checkout");

                    }}
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


                <div className="checkout-success-icon">

                    <Check
                        size={38}
                        strokeWidth={2.5}
                    />

                </div>

                <h2>

                    Assinatura ativada!

                </h2>

                <p>

                    Seu pagamento foi aprovado com sucesso.

                </p>

                <button
                    className="checkout-submit-button"
                    onClick={() => navigate("/")}
                >
                    Voltar para o início
                </button>

            </div>

        </main>

    );

}

if (checkoutStep === "create-account") {

    return (

        <main className="checkout">

            <div className="checkout-account-page">

                <div className="checkout-account-icon">

                    <LockKeyhole size={38}/>

                </div>


                <h2>
                    Crie sua senha
                </h2>


                <p>

                    Seu pagamento foi aprovado.
                    Agora falta apenas criar sua senha para finalizar sua conta Xia.

                </p>


                <div className="checkout-field">

                    <label>
                        Senha
                    </label>


                    <div className="checkout-password-wrapper">

                        <input
                            type={
                                showPassword
                                ? "text"
                                : "password"
                            }
                            placeholder="Digite sua senha"
                            value={password}
                            onChange={(e)=>{

                                setPassword(e.target.value);

                                setPasswordError("");

                            }}
                        />


                        <button
                            type="button"
                            className="checkout-eye-button"
                            onClick={()=>setShowPassword(!showPassword)}
                        >

                            {
                                showPassword
                                ?
                                <EyeOff size={20}/>
                                :
                                <Eye size={20}/>
                            }

                        </button>

                    </div>

                </div>


                {passwordError && (

                    <p className="checkout-error-message">
                        {passwordError}
                    </p>

                )}



                <div className="checkout-field">

                    <label>
                        Confirmar senha
                    </label>


                    <div className="checkout-password-wrapper">

                        <input
                            type={
                                showConfirmPassword
                                ?
                                "text"
                                :
                                "password"
                            }
                            placeholder="Confirme sua senha"
                            value={confirmPassword}
                            onChange={(e)=>{

                                setConfirmPassword(e.target.value);

                                setConfirmPasswordError("");

                            }}
                        />


                        <button
                            type="button"
                            className="checkout-eye-button"
                            onClick={()=>setShowConfirmPassword(!showConfirmPassword)}
                        >

                            {
                                showConfirmPassword
                                ?
                                <EyeOff size={20}/>
                                :
                                <Eye size={20}/>
                            }

                        </button>

                    </div>

                </div>


                {confirmPasswordError && (

                    <p className="checkout-error-message">
                        {confirmPasswordError}
                    </p>

                )}



                <button
                    className="checkout-submit-button"
                    onClick={handleCreateAccount}
                    disabled={creatingAccount}
                >

                    {
                        creatingAccount
                        ?
                        "Criando conta..."
                        :
                        "Criar conta"
                    }

                </button>


            </div>

        </main>

    );

}

async function handleCreateAccount() {

    if (creatingAccount) {
        return;
    }

    setPasswordError("");
    setConfirmPasswordError("");

    if (password.length < 6) {

        setPasswordError(
            "A senha deve conter pelo menos 6 caracteres."
        );

        return;

    }

    if (password !== confirmPassword) {

        setConfirmPasswordError(
            "As senhas não coincidem."
        );

        return;

    }

    if (!subscriptionResponse?.subscription_id) {

        setPasswordError(
            "Não foi possível localizar os dados da assinatura."
        );

        return;

    }

    try {

        setCreatingAccount(true);

        const userCredential =
            await createUserWithEmailAndPassword(
                auth,
                email,
                password
            );

        await createUserDocument(
            userCredential.user
        );


        await linkSubscription({

            firebase_uid:
                userCredential.user.uid,

            email,

            subscription_id:
                subscriptionResponse.subscription_id

        });


        setCheckoutStep("success");

    } catch (error) {

        const authError = error as FirebaseError;

        switch (authError.code) {

            case "auth/email-already-in-use":

                setPasswordError(
                    "Este e-mail já possui uma conta."
                );

                break;

            default:

                setPasswordError(
                    "Não foi possível criar a conta."
                );

                break;

        }

    } finally {

        setCreatingAccount(false);

    }

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


                            {checkoutError && (

                                <p className="checkout-error-message">
                                    {checkoutError}
                                </p>

                            )}


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



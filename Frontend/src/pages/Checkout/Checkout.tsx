import { formatCredits } from "../../utils/formatCredits";
import "./Checkout.css";

import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { CheckCircle2, CreditCard, LoaderCircle, QrCode, Zap } from "lucide-react";

import type { Plan } from "../../config/plans";
import auth from "../../firebase/auth";
import {
    createCardOrder,
    createPaymentAttempt,
    createPixOrder,
    createTopup,
    getTopupStatus,
} from "../../api/topups";
import type { MercadoPagoInstance } from "../../types/mercadopago";

type PaymentMethod = "pix" | "card";
type PixStage =
    | "idle"
    | "creating_topup"
    | "creating_attempt"
    | "creating_order"
    | "waiting_payment"
    | "approved"
    | "terminal"
    | "error";

interface PixState {
    stage: PixStage;
    topupId: string | null;
    paymentAttemptId: string | null;
    orderId: string | null;
    status: string | null;
    statusDetail: string | null;
    qrCode: string | null;
    qrCodeBase64: string | null;
    ticketUrl: string | null;
    expiresAt: string | null;
    error: string;
}

type CardStage =
    | "idle"
    | "creating_topup"
    | "creating_attempt"
    | "tokenizing"
    | "processing"
    | "approved"
    | "rejected"
    | "error";

interface CardState {
    stage: CardStage;
    topupId: string | null;
    paymentAttemptId: string | null;
    orderId: string | null;
    status: string | null;
    statusDetail: string | null;
    error: string;
    retryAllowed: boolean;
    creditsGranted: boolean;
}

const INITIAL_PIX_STATE: PixState = {
    stage: "idle",
    topupId: null,
    paymentAttemptId: null,
    orderId: null,
    status: null,
    statusDetail: null,
    qrCode: null,
    qrCodeBase64: null,
    ticketUrl: null,
    expiresAt: null,
    error: "",
};

const INITIAL_CARD_STATE: CardState = {
    stage: "idle",
    topupId: null,
    paymentAttemptId: null,
    orderId: null,
    status: null,
    statusDetail: null,
    error: "",
    retryAllowed: true,
    creditsGranted: false,
};

function isValidCpf(cpf: string) {
    const numbers = cpf.replace(/\D/g, "");
    if (numbers.length !== 11 || /^(\d)\1{10}$/.test(numbers)) return false;

    const calculateDigit = (base: string, factor: number) => {
        let total = 0;
        for (const digit of base) {
            total += Number(digit) * factor;
            factor--;
        }
        const remainder = (total * 10) % 11;
        return remainder === 10 ? 0 : remainder;
    };

    const firstDigit = calculateDigit(numbers.slice(0, 9), 10);
    if (firstDigit !== Number(numbers[9])) return false;
    return calculateDigit(numbers.slice(0, 10), 11) === Number(numbers[10]);
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

function isValidCardNumber(value: string) {
    const digits = value.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return false;

    let sum = 0;
    let doubleDigit = false;
    for (let index = digits.length - 1; index >= 0; index--) {
        let digit = Number(digits[index]);
        if (doubleDigit) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
        doubleDigit = !doubleDigit;
    }
    return sum % 10 === 0;
}

export default function Checkout() {
    const location = useLocation();
    const navigate = useNavigate();
    const selectedPackage = location.state?.plan as Plan | undefined;

    const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("pix");
    const [cpf, setCpf] = useState("");
    const [cardHolderName, setCardHolderName] = useState("");
    const [cardNumber, setCardNumber] = useState("");
    const [cardExpiry, setCardExpiry] = useState("");
    const [cardCvv, setCardCvv] = useState("");
    const [pixState, setPixState] = useState<PixState>(INITIAL_PIX_STATE);
    const [cardState, setCardState] = useState<CardState>(INITIAL_CARD_STATE);
    const [copyFeedback, setCopyFeedback] = useState(false);
    const pixRequestInFlight = useRef(false);
    const cardRequestInFlight = useRef(false);
    const mercadoPagoRef = useRef<MercadoPagoInstance | null>(null);
    const statusRequestInFlight = useRef(false);

    const isPixLoading = [
        "creating_topup",
        "creating_attempt",
        "creating_order",
    ].includes(pixState.stage);
    const hasActivePix = pixState.stage === "waiting_payment" ||
        pixState.stage === "approved";
    const isCardSubmitting = [
        "creating_topup",
        "creating_attempt",
        "tokenizing",
    ].includes(cardState.stage) || (
        cardState.stage === "processing" && !cardState.orderId
    );
    const hasActiveCard = cardState.stage === "approved" || (
        cardState.stage === "processing" && Boolean(cardState.orderId)
    );
    const isPaymentMethodLocked = isPixLoading || hasActivePix ||
        isCardSubmitting || hasActiveCard;

    const activeTopupId = paymentMethod === "pix"
        ? (pixState.stage === "waiting_payment" ? pixState.topupId : null)
        : (cardState.orderId && !cardState.creditsGranted &&
            ["processing", "approved"].includes(cardState.stage)
            ? cardState.topupId : null);

    useEffect(() => {
        if (!activeTopupId) return;

        let cancelled = false;
        let timer: ReturnType<typeof window.setTimeout> | undefined;
        const terminalMessages: Record<string, string> = {
            failed: "O pagamento falhou.",
            cancelled: "O pagamento foi cancelado.",
            expired: "O pagamento expirou.",
            refunded: "O pagamento foi reembolsado.",
        };

        async function pollStatus() {
            if (cancelled) return;
            if (statusRequestInFlight.current) {
                timer = window.setTimeout(pollStatus, 3000);
                return;
            }

            statusRequestInFlight.current = true;
            let finished = false;
            try {
                const topup = await getTopupStatus(activeTopupId!);
                if (cancelled || topup.topup_id !== activeTopupId) return;

                const approved = topup.status === "approved" &&
                    topup.credits_granted === true;
                const terminalError = terminalMessages[topup.status ?? ""];
                finished = approved || Boolean(terminalError);

                if (paymentMethod === "pix") {
                    setPixState((current) => cancelled ||
                        current.topupId !== activeTopupId ? current : {
                            ...current,
                            stage: approved ? "approved" : terminalError
                                ? "terminal" : "waiting_payment",
                            status: topup.status,
                            statusDetail: topup.status_detail,
                            error: terminalError ?? "",
                        });
                } else {
                    setCardState((current) => cancelled ||
                        current.topupId !== activeTopupId ? current : {
                            ...current,
                            stage: approved ? "approved" : terminalError
                                ? "rejected" : "processing",
                            status: topup.status,
                            statusDetail: topup.status_detail,
                            creditsGranted: approved,
                            error: terminalError ?? "",
                            retryAllowed: Boolean(terminalError) &&
                                topup.status !== "refunded",
                        });
                }
            } catch {
                // Falha de consulta não confirma nem recusa o pagamento.
            } finally {
                statusRequestInFlight.current = false;
                if (!cancelled && !finished) {
                    timer = window.setTimeout(pollStatus, 3000);
                }
            }
        }

        void pollStatus();
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [activeTopupId, paymentMethod]);

    if (!selectedPackage) return <Navigate to="/creditos" replace />;
    const packageId = selectedPackage.id;
    const isPaymentConfirmed = paymentMethod === "pix"
        ? pixState.stage === "approved"
        : cardState.stage === "approved" && cardState.creditsGranted === true;
    const isConfirmingCardCredits = cardState.stage === "approved" ||
        cardState.status === "approved";

    function selectPaymentMethod(method: PaymentMethod) {
        setPaymentMethod(method);
        if (method === "card" && cardState.stage === "error") {
            setCardState((current) => ({ ...current, error: "" }));
        }
    }

    async function handleGeneratePix() {
        if (pixRequestInFlight.current || isPixLoading || hasActivePix) return;
        pixRequestInFlight.current = true;

        let topupId = pixState.topupId;
        let paymentAttemptId = pixState.paymentAttemptId;

        try {
            if (!topupId) {
                setPixState((current) => ({
                    ...current,
                    stage: "creating_topup",
                    error: "",
                }));
                const topup = await createTopup(packageId);
                if (!topup.topup_id) throw new Error("invalid_topup_response");
                topupId = topup.topup_id;
                setPixState((current) => ({
                    ...current,
                    topupId,
                }));
            }

            if (!paymentAttemptId) {
                setPixState((current) => ({
                    ...current,
                    stage: "creating_attempt",
                }));
                const attempt = await createPaymentAttempt(topupId, "pix");
                if (
                    !attempt.payment_attempt_id ||
                    attempt.topup_id !== topupId
                ) {
                    throw new Error("invalid_attempt_response");
                }
                paymentAttemptId = attempt.payment_attempt_id;
                setPixState((current) => ({
                    ...current,
                    paymentAttemptId,
                }));
            }

            setPixState((current) => ({
                ...current,
                stage: "creating_order",
            }));
            const order = await createPixOrder(topupId, paymentAttemptId);

            if (
                !order.order_id || !order.qr_code || !order.qr_code_base64 ||
                order.topup_id !== topupId ||
                order.payment_attempt_id !== paymentAttemptId
            ) {
                throw new Error("invalid_pix_response");
            }

            setPixState({
                stage: "waiting_payment",
                topupId,
                paymentAttemptId,
                orderId: order.order_id,
                status: order.status,
                statusDetail: order.status_detail,
                qrCode: order.qr_code,
                qrCodeBase64: order.qr_code_base64,
                ticketUrl: order.ticket_url,
                expiresAt: order.expires_at,
                error: "",
            });
        } catch {
            pixRequestInFlight.current = false;
            setPixState((current) => ({
                ...current,
                stage: "error",
                error: "Não foi possível gerar o Pix. Tente novamente.",
            }));
        }
    }

    async function handleCopyPixCode() {
        if (!pixState.qrCode) return;

        try {
            await navigator.clipboard.writeText(pixState.qrCode);
            setCopyFeedback(true);
            window.setTimeout(() => setCopyFeedback(false), 2000);
        } catch {
            setPixState((current) => ({
                ...current,
                error: "Não foi possível copiar o código automaticamente.",
            }));
        }
    }

    function validateCardForm() {
        setCardState((current) => ({ ...current, error: "" }));

        if (
            !cpf.trim() || !cardNumber.trim() || !cardHolderName.trim() ||
            !cardExpiry.trim() || !cardCvv.trim()
        ) {
            setCardState((current) => ({
                ...current,
                stage: "error",
                error: "Preencha todos os campos para continuar.",
                retryAllowed: true,
            }));
            return false;
        }
        if (!isValidCpf(cpf)) {
            setCardState((current) => ({
                ...current,
                stage: "error",
                error: "Digite um CPF válido.",
                retryAllowed: true,
            }));
            return false;
        }
        if (!isValidCardNumber(cardNumber)) {
            setCardState((current) => ({
                ...current,
                stage: "error",
                error: "Digite um número de cartão válido.",
                retryAllowed: true,
            }));
            return false;
        }
        if (cardHolderName.trim().length < 3) {
            setCardState((current) => ({
                ...current,
                stage: "error",
                error: "Digite o nome do titular do cartão.",
                retryAllowed: true,
            }));
            return false;
        }

        const [expiryMonth, expiryYear] = cardExpiry.split("/");
        const monthNumber = Number(expiryMonth);
        const yearNumber = Number(`20${expiryYear}`);
        const currentDate = new Date();
        const currentMonth = currentDate.getMonth() + 1;
        const currentYear = currentDate.getFullYear();

        if (
            !expiryMonth || !expiryYear || expiryMonth.length !== 2 ||
            expiryYear.length !== 2 || monthNumber < 1 || monthNumber > 12
        ) {
            setCardState((current) => ({
                ...current,
                stage: "error",
                error: "Digite uma validade de cartão válida.",
                retryAllowed: true,
            }));
            return false;
        }
        if (
            yearNumber < currentYear ||
            (yearNumber === currentYear && monthNumber < currentMonth)
        ) {
            setCardState((current) => ({
                ...current,
                stage: "error",
                error: "Este cartão está vencido.",
                retryAllowed: true,
            }));
            return false;
        }
        const cvvLength = cardCvv.replace(/\D/g, "").length;
        if (cvvLength < 3 || cvvLength > 4) {
            setCardState((current) => ({
                ...current,
                stage: "error",
                error: "Digite um CVV válido.",
                retryAllowed: true,
            }));
            return false;
        }

        return true;
    }

    function getMercadoPago() {
        if (mercadoPagoRef.current) return mercadoPagoRef.current;

        const publicKey = import.meta.env.VITE_MERCADO_PAGO_PUBLIC_KEY;
        if (!publicKey || !window.MercadoPago) {
            throw new Error("mercado_pago_unavailable");
        }

        mercadoPagoRef.current = new window.MercadoPago(publicKey, {
            locale: "pt-BR",
        });
        return mercadoPagoRef.current;
    }

    async function handleCardPayment() {
        if (
            cardRequestInFlight.current || isCardSubmitting || hasActiveCard ||
            !validateCardForm()
        ) return;

        cardRequestInFlight.current = true;
        let topupId = cardState.topupId;
        let paymentAttemptId = cardState.paymentAttemptId;
        let orderSubmissionStarted = false;
        let tokenCreated = false;

        try {
            if (!topupId) {
                setCardState((current) => ({
                    ...current,
                    stage: "creating_topup",
                    error: "",
                }));
                const topup = await createTopup(packageId);
                if (!topup.topup_id) throw new Error("invalid_topup_response");
                topupId = topup.topup_id;
                setCardState((current) => ({ ...current, topupId }));
            }

            if (!paymentAttemptId) {
                setCardState((current) => ({
                    ...current,
                    stage: "creating_attempt",
                }));
                const attempt = await createPaymentAttempt(topupId, "card");
                if (
                    !attempt.payment_attempt_id || attempt.topup_id !== topupId ||
                    attempt.payment_method !== "card"
                ) {
                    throw new Error("invalid_attempt_response");
                }
                paymentAttemptId = attempt.payment_attempt_id;
                setCardState((current) => ({
                    ...current,
                    paymentAttemptId,
                }));
            }

            setCardState((current) => ({ ...current, stage: "tokenizing" }));
            const mercadoPago = getMercadoPago();
            const rawCardNumber = cardNumber.replace(/\D/g, "");
            const paymentMethods = await mercadoPago.getPaymentMethods({
                bin: rawCardNumber.slice(0, 8),
            });
            const paymentMethod = paymentMethods.results.find(
                (method) => method.payment_type_id === "credit_card"
            );
            if (!paymentMethod?.id) {
                throw new Error("unsupported_payment_method");
            }

            const [expirationMonth, expirationYear] = cardExpiry.split("/");
            const cardToken = await mercadoPago.createCardToken({
                cardNumber: rawCardNumber,
                cardholderName: cardHolderName.trim(),
                identificationType: "CPF",
                identificationNumber: cpf.replace(/\D/g, ""),
                securityCode: cardCvv,
                cardExpirationMonth: expirationMonth,
                cardExpirationYear: expirationYear,
            });
            if (!cardToken.id) throw new Error("invalid_card_token");
            tokenCreated = true;

            setCardState((current) => ({ ...current, stage: "processing" }));
            orderSubmissionStarted = true;
            const order = await createCardOrder(topupId, paymentAttemptId, {
                card_token: cardToken.id,
                payment_method_id: paymentMethod.id,
                installments: 1,
                identification_type: "CPF",
                identification_number: cpf.replace(/\D/g, ""),
            });
            if (
                !order.order_id || order.topup_id !== topupId ||
                order.payment_attempt_id !== paymentAttemptId
            ) {
                throw new Error("invalid_card_order_response");
            }

            const approved = order.status === "processed" &&
                order.status_detail === "accredited";
            const rejected = ["failed", "rejected", "cancelled", "canceled"]
                .includes(order.status);
            setCardState({
                stage: approved ? "approved" : rejected ? "rejected" : "processing",
                topupId,
                paymentAttemptId,
                orderId: order.order_id,
                status: order.status,
                statusDetail: order.status_detail,
                error: "",
                retryAllowed: rejected,
                creditsGranted: false,
            });
        } catch {
            setCardState((current) => ({
                ...current,
                stage: "error",
                topupId,
                paymentAttemptId,
                error: orderSubmissionStarted
                    ? "Não foi possível confirmar o resultado do pagamento."
                    : "Não foi possível processar os dados do cartão. Tente novamente.",
                retryAllowed: !orderSubmissionStarted,
            }));
        } finally {
            if (tokenCreated) {
                setCardNumber("");
                setCardExpiry("");
                setCardCvv("");
            }
            cardRequestInFlight.current = false;
        }
    }

    function startNewCardAttempt() {
        if (!cardState.retryAllowed || isCardSubmitting) return;
        setCardState((current) => ({
            ...INITIAL_CARD_STATE,
            topupId: current.topupId,
        }));
    }

    return (
        <main className="checkout">
            <div className="checkout-container">
                <header className="checkout-header">
                    <h1 className="checkout-title">
                        Finalizar <span>recarga</span>
                    </h1>
                    <p className="checkout-description">
                        Escolha a forma de pagamento e conclua sua compra de créditos.
                    </p>
                </header>

                <section className="checkout-layout">
                    <div className={`checkout-form-card${isPaymentConfirmed ? " checkout-form-card-success" : ""}`}>
                        {isPaymentConfirmed ? (
                            <div className="checkout-success checkout-success-confirmed" role="status">
                                <div className="checkout-success-icon" aria-hidden="true">
                                    <CheckCircle2 size={48} strokeWidth={1.6} />
                                </div>
                                <h2 className="checkout-success-title">Pagamento confirmado!</h2>
                                <p className="checkout-success-description">
                                    Seus créditos já foram adicionados à sua conta.
                                </p>
                                <div className="checkout-success-credits">
                                    <span>Pacote {selectedPackage.name}</span>
                                    <strong>{formatCredits(selectedPackage.credits)} <span>créditos</span></strong>
                                    <small>Recarga concluída com sucesso</small>
                                </div>
                                <button
                                    type="button"
                                    className="checkout-submit-button"
                                    onClick={() => navigate("/creditos")}
                                >
                                    <span aria-hidden="true">→ </span>Ir para meus créditos
                                </button>
                            </div>
                        ) : (
                        <>
                        <h2 className="checkout-card-title">Forma de pagamento</h2>
                        <p className="checkout-card-description">
                            Selecione como deseja pagar por esta recarga.
                        </p>

                        <div
                            className="checkout-payment-methods"
                            role="tablist"
                            aria-label="Forma de pagamento"
                        >
                            <button
                                type="button"
                                role="tab"
                                aria-selected={paymentMethod === "pix"}
                                className={paymentMethod === "pix"
                                    ? "checkout-payment-method checkout-payment-method-active"
                                    : "checkout-payment-method"}
                                disabled={isPaymentMethodLocked}
                                onClick={() => selectPaymentMethod("pix")}
                            >
                                <QrCode size={22} /> Pix
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={paymentMethod === "card"}
                                className={paymentMethod === "card"
                                    ? "checkout-payment-method checkout-payment-method-active"
                                    : "checkout-payment-method"}
                                disabled={isPaymentMethodLocked}
                                onClick={() => selectPaymentMethod("card")}
                            >
                                <CreditCard size={22} /> Cartão
                            </button>
                        </div>

                        {paymentMethod === "pix" ? (
                            <div className="checkout-payment-content">
                                {pixState.stage === "terminal" ? (
                                    <p>Pagamento encerrado.</p>
                                ) : hasActivePix ? (
                                    <div className="checkout-pix-payment">
                                        <div className="checkout-pix-status">
                                            <span className="checkout-pix-status-badge">
                                                {pixState.status === "approved"
                                                    ? "Confirmando créditos..."
                                                    : pixState.status === "processing"
                                                        ? "Pagamento em processamento"
                                                        : "Aguardando pagamento"}
                                            </span>
                                            <p>
                                                Seus créditos serão adicionados automaticamente
                                                após a confirmação segura do pagamento.
                                            </p>
                                        </div>

                                        <div className="checkout-processing-confirmation" role="status">
                                            <LoaderCircle className="checkout-processing-spinner" size={20} aria-hidden="true" />
                                            <span>Aguardando confirmação do pagamento...</span>
                                        </div>

                                        <img
                                            className="checkout-pix-qr-code"
                                            src={`data:image/png;base64,${pixState.qrCodeBase64}`}
                                            alt="QR Code Pix para pagamento"
                                        />

                                        <div className="checkout-pix-copy">
                                            <label htmlFor="pix-copy-code">
                                                Pix copia e cola
                                            </label>
                                            <div className="checkout-pix-copy-row">
                                                <input
                                                    id="pix-copy-code"
                                                    value={pixState.qrCode ?? ""}
                                                    readOnly
                                                />
                                                <button
                                                    type="button"
                                                    onClick={handleCopyPixCode}
                                                >
                                                    {copyFeedback ? "Copiado!" : "Copiar código"}
                                                </button>
                                            </div>
                                        </div>

                                        {pixState.expiresAt === "PT24H" && (
                                            <p className="checkout-pix-expiration">
                                                Este Pix expira em até 24 horas.
                                            </p>
                                        )}
                                    </div>
                                ) : (
                                    <>
                                        <div className="checkout-pix-info">
                                            <div className="checkout-pix-icon">
                                                {isPixLoading
                                                    ? <span className="checkout-pix-spinner" />
                                                    : <Zap size={30} />}
                                            </div>
                                            <div>
                                                <h3>
                                                    {isPixLoading
                                                        ? "Gerando seu Pix..."
                                                        : "Pagamento instantâneo com Pix"}
                                                </h3>
                                                <p>
                                                    {isPixLoading
                                                        ? "Aguarde enquanto preparamos o QR Code."
                                                        : "O QR Code e o código copia e cola serão gerados no próximo passo."}
                                                </p>
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            className="checkout-submit-button"
                                            disabled={isPixLoading}
                                            onClick={handleGeneratePix}
                                        >
                                            {isPixLoading ? "Gerando seu Pix..." : (
                                                pixState.stage === "error"
                                                    ? "Tentar gerar Pix novamente"
                                                    : "Gerar Pix"
                                            )}
                                        </button>
                                    </>
                                )}

                                {pixState.error && (
                                    <p className="checkout-error-message">
                                        {pixState.error}
                                    </p>
                                )}
                            </div>
                        ) : (
                            <div className="checkout-payment-content">
                                {auth.currentUser?.email && (
                                    <div className="checkout-account-info">
                                        <span>Conta</span>
                                        <strong>{auth.currentUser.email}</strong>
                                    </div>
                                )}

                                {cardState.orderId && [
                                    "approved",
                                    "rejected",
                                    "processing",
                                ].includes(cardState.stage) ? (
                                    <div className={`checkout-card-result checkout-card-result-${
                                        cardState.stage === "approved" && !cardState.creditsGranted
                                            ? "processing" : cardState.stage
                                    }`} role="status">
                                        {cardState.stage === "rejected" ? (
                                            <CreditCard size={34} aria-hidden="true" />
                                        ) : (
                                            <LoaderCircle className="checkout-processing-spinner" size={34} aria-hidden="true" />
                                        )}
                                        <h3>
                                            {cardState.stage === "rejected"
                                                ? "Pagamento encerrado"
                                                : isConfirmingCardCredits
                                                    ? "Pagamento aprovado"
                                                    : "Pagamento em processamento"}
                                        </h3>
                                        <p>
                                            {cardState.stage === "rejected"
                                                ? cardState.error || "Não foi possível aprovar este cartão. Confira os dados ou tente outro cartão."
                                                : isConfirmingCardCredits
                                                    ? "Estamos confirmando seus créditos. Isso pode levar alguns segundos."
                                                    : "Estamos aguardando a confirmação do pagamento. Isso pode levar alguns segundos."}
                                        </p>
                                        {cardState.stage === "rejected" && cardState.retryAllowed && (
                                            <button
                                                type="button"
                                                className="checkout-submit-button"
                                                onClick={startNewCardAttempt}
                                            >
                                                Tentar novamente
                                            </button>
                                        )}
                                    </div>
                                ) : <div className="checkout-form">
                                    <div className="checkout-field">
                                        <label>CPF</label>
                                        <input
                                            type="text"
                                            inputMode="numeric"
                                            placeholder="000.000.000-00"
                                            value={cpf}
                                            onChange={(event) =>
                                                setCpf(formatCPF(event.target.value))}
                                        />
                                    </div>

                                    <h3 className="checkout-section-title">Dados do cartão</h3>

                                    <div className="checkout-field">
                                        <label>Número do cartão</label>
                                        <input
                                            type="text"
                                            inputMode="numeric"
                                            placeholder="1234 5678 9012 3456"
                                            value={cardNumber}
                                            onChange={(event) => {
                                                const value = event.target.value
                                                    .replace(/\D/g, "").slice(0, 19);
                                                setCardNumber(
                                                    value.replace(/(\d{4})(?=\d)/g, "$1 ")
                                                );
                                            }}
                                        />
                                    </div>

                                    <div className="checkout-field">
                                        <label>Nome impresso no cartão</label>
                                        <input
                                            type="text"
                                            placeholder="Nome igual ao cartão"
                                            value={cardHolderName}
                                            onChange={(event) => setCardHolderName(
                                                formatCardHolder(
                                                    event.target.value.toUpperCase()
                                                )
                                            )}
                                        />
                                    </div>

                                    <div className="checkout-field-row">
                                        <div className="checkout-field">
                                            <label>Validade</label>
                                            <input
                                                type="text"
                                                inputMode="numeric"
                                                placeholder="MM/AA"
                                                value={cardExpiry}
                                                onChange={(event) => {
                                                    const value = event.target.value
                                                        .replace(/\D/g, "").slice(0, 4);
                                                    setCardExpiry(value.length >= 3
                                                        ? `${value.slice(0, 2)}/${value.slice(2)}`
                                                        : value);
                                                }}
                                            />
                                        </div>
                                        <div className="checkout-field">
                                            <label>CVV</label>
                                            <input
                                                type="text"
                                                inputMode="numeric"
                                                placeholder="123"
                                                value={cardCvv}
                                                onChange={(event) => setCardCvv(
                                                    event.target.value
                                                        .replace(/\D/g, "").slice(0, 4)
                                                )}
                                            />
                                        </div>
                                    </div>

                                    <button
                                        type="button"
                                        className="checkout-submit-button"
                                        disabled={
                                            isCardSubmitting ||
                                            (cardState.stage === "error" &&
                                                !cardState.retryAllowed)
                                        }
                                        onClick={handleCardPayment}
                                    >
                                        {cardState.stage === "creating_topup"
                                            ? "Iniciando recarga..."
                                            : cardState.stage === "creating_attempt"
                                                ? "Preparando pagamento..."
                                                : cardState.stage === "tokenizing"
                                                    ? "Validando cartão..."
                                                    : cardState.stage === "processing"
                                                        ? "Processando pagamento..."
                                                        : "Pagar com cartão"}
                                    </button>
                                </div>}

                                {cardState.error && (
                                    <p className="checkout-error-message">
                                        {cardState.error}
                                    </p>
                                )}
                            </div>
                        )}
                        </>
                        )}
                    </div>

                    <aside className="checkout-summary-card">
                        <h2 className="checkout-card-title">Resumo da recarga</h2>
                        <p className="checkout-card-description">
                            Confira as informações do pacote selecionado.
                        </p>
                        <div className="checkout-summary">
                            <div className="checkout-summary-row">
                                <span>Pacote</span>
                                <strong>{selectedPackage.name}</strong>
                            </div>
                            <div className="checkout-summary-row">
                                <span>Créditos</span>
                                <strong>{formatCredits(selectedPackage.credits)}</strong>
                            </div>
                            <div className="checkout-summary-divider" />
                            <div className="checkout-summary-total">
                                <span>Total</span>
                                <strong>
                                    {selectedPackage.price.toLocaleString("pt-BR", {
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

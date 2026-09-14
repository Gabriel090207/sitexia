import api from "./api";


export interface CreateTopupResponse {
    topup_id: string;
    package: {
        id: string;
        name: string;
    };
    amount: number;
    currency: "BRL";
    credits: number;
    status: string;
}


export interface CreatePaymentAttemptResponse {
    topup_id: string;
    payment_attempt_id: string;
    payment_method: "pix" | "card";
    status: string;
}


export interface CreatePixOrderResponse {
    topup_id: string;
    payment_attempt_id: string;
    order_id: string;
    status: string;
    status_detail: string;
    qr_code: string | null;
    qr_code_base64: string | null;
    ticket_url: string | null;
    expires_at: string | null;
}


export interface CreateCardOrderPayload {
    card_token: string;
    payment_method_id: string;
    installments: number;
    identification_type: "CPF";
    identification_number: string;
}


export interface CreateCardOrderResponse {
    topup_id: string;
    payment_attempt_id: string;
    order_id: string;
    payment_id: string | null;
    status: string;
    status_detail: string;
}


export interface TopupStatusResponse {
    topup_id: string;
    status: string | null;
    status_detail: string | null;
    credits_granted: boolean;
}


export async function getTopupStatus(topupId: string) {
    const response = await api.get<TopupStatusResponse>(
        `/topups/${topupId}/status`
    );
    return response.data;
}


export async function createTopup(packageId: string) {
    const response = await api.post<CreateTopupResponse>(
        "/topups",
        { package_id: packageId }
    );
    return response.data;
}


export async function createPaymentAttempt(
    topupId: string,
    paymentMethod: "pix" | "card"
) {
    const response = await api.post<CreatePaymentAttemptResponse>(
        `/topups/${topupId}/payment-attempts`,
        { payment_method: paymentMethod }
    );
    return response.data;
}


export async function createPixOrder(
    topupId: string,
    paymentAttemptId: string
) {
    const response = await api.post<CreatePixOrderResponse>(
        `/topups/${topupId}/payment-attempts/${paymentAttemptId}/order`
    );
    return response.data;
}


export async function createCardOrder(
    topupId: string,
    paymentAttemptId: string,
    payload: CreateCardOrderPayload
) {
    const response = await api.post<CreateCardOrderResponse>(
        `/topups/${topupId}/payment-attempts/${paymentAttemptId}/order/card`,
        payload
    );
    return response.data;
}

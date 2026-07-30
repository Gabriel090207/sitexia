import api from "./api";

export interface CreateSubscriptionRequest {

    user_id: string;

    token: string;

    email: string;

    cpf: string;

    amount: number;

    card_holder: string;

}

export async function createSubscription(
    data: CreateSubscriptionRequest
) {

    const response = await api.post(
        "/subscription/create-subscription",
        data
    );

    return response.data;

}
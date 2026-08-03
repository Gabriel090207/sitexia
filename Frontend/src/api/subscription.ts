import api from "./api";

export interface CreateSubscriptionRequest {

    user_id: string;

    token: string;

    email: string;

    cpf: string;

    amount: number;

    card_holder: string;

    plan_id: string;

    plan_name: string;

    credits: number;

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


export interface LinkSubscriptionRequest {

    firebase_uid: string;

    email: string;

    subscription_id: string;

}


export async function linkSubscription(
    data: LinkSubscriptionRequest
) {

    const response = await api.post(
        "/subscription/link-user",
        data
    );

    return response.data;

}

export interface CancelSubscriptionRequest {

    subscription_id: string;

}

export async function cancelSubscription(

    data: CancelSubscriptionRequest

) {

    const response = await api.post(

        "/subscription/cancel",

        data

    );

    return response.data;

}
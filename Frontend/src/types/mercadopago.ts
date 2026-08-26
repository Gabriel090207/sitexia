export interface MercadoPagoConstructor {

    new (
        publicKey: string,
        options?: {
            locale?: string;
        }
    ): MercadoPagoInstance;

}

export interface MercadoPagoInstance {

    getPaymentMethods(data: {
        bin: string;
    }): Promise<{
        results: Array<{
            id: string;
            payment_type_id: string;
        }>;
    }>;

    createCardToken(data: {
        cardNumber: string;
        cardholderName: string;
        identificationType: string;
        identificationNumber: string;
        securityCode: string;
        cardExpirationMonth: string;
        cardExpirationYear: string;
    }): Promise<{
        id: string;
    }>;

}

declare global {

    interface Window {

        MercadoPago: MercadoPagoConstructor;

    }

}

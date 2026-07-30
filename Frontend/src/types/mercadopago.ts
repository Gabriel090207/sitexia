export interface MercadoPagoConstructor {

    new (
        publicKey: string,
        options?: {
            locale?: string;
        }
    ): MercadoPagoInstance;

}

export interface MercadoPagoInstance {

    createCardToken(data: {
        cardNumber: string;
        cardholderName: string;
        identificationType: string;
        identificationNumber: string;
        securityCode: string;
        cardExpirationMonth: string;
        cardExpirationYear: string;
    }): Promise<any>;

}

declare global {

    interface Window {

        MercadoPago: MercadoPagoConstructor;

    }

}
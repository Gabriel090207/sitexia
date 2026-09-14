export interface Plan {

    id: string;

    name: string;

    price: number;

    credits: number;

}

export const PLANS: Plan[] = [

    {
        id: "starter",
        name: "Starter",
        price: 129.90,
        credits: 12,
    },

    {
        id: "pro",
        name: "Pro",
        price: 599.90,
        credits: 80,
    },

    {
        id: "enterprise",
        name: "Enterprise",
        price: 2599.90,
        credits: 350,
    },

];

export function formatPlanPrice(
    price: number
) {
    return price.toLocaleString(
        "pt-BR",
        {
            style: "currency",
            currency: "BRL",
        }
    );
}
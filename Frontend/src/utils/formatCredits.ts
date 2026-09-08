const creditsFormatter = new Intl.NumberFormat("en-US", {
    useGrouping: false,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

/** Formata apenas a apresentação; não usar o retorno em cálculos. */
export function formatCredits(value: number): string {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError("A quantidade de créditos deve ser um número finito.");
    }
    return creditsFormatter.format(value);
}

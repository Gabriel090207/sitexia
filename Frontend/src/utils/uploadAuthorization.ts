/** UI guard only. Storage Security Rules must enforce access independently. */
export function allowAuthenticatedUpload(
    user: { uid: string } | null,
    loading: boolean,
    currentUser: { uid: string } | null,
    report: (message: string) => void,
): boolean {
    if (loading) {
        report("Aguarde a confirmação do login antes de enviar arquivos.");
        return false;
    }
    if (!user || !currentUser || user.uid !== currentUser.uid) {
        report("Faça login para enviar arquivos.");
        return false;
    }
    report("");
    return true;
}

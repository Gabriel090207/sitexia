// Temporary uploads now return canonical token-free object references even
// against the Storage Emulator. This adapter checks representation only.
import { uploadScopedFile as original } from '../../src/services/scopedUploads.ts?actual';
export async function uploadScopedFile(...args: Parameters<typeof original>) {
    const address = new URL(await original(...args));
    if (address.origin !== 'https://firebasestorage.googleapis.com' || address.search || address.hash) {
        throw new Error('Invalid temporary object reference');
    }
    return address.href;
}

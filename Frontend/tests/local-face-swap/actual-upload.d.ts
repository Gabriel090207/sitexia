declare module '*scopedUploads.ts?actual' {
    export function uploadScopedFile(file: File, folder: 'face-swap' | 'face-swap-faces' | 'video-generation', expectedUid: string | undefined): Promise<string>;
}

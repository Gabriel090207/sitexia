import {
    addDoc,
    collection,
    serverTimestamp,
    onSnapshot,
    query,
    orderBy,
    getDocs,
    where,
    limit,
} from "firebase/firestore";

import db from "../firebase/firestore";

export async function createLibraryImage(

    userId: string,

    imageUrl: string,

    type: "face-swap" | "image-generation",

){

    await addDoc(

        collection(
            db,
            "users",
            userId,
            "swaps"
        ),

        {
            imageUrl,

            type,

            createdAt: serverTimestamp(),
        }

    );

}

export async function createLibraryVideo(
    userId: string,
    videoUrl: string,
    taskId: string,
    origin: "video-generation" | "face-swap" = "video-generation"
) {

    const document = await addDoc(
        collection(
            db,
            "users",
            userId,
            "swaps"
        ),
        {
            videoUrl,

            taskId,

            type: origin,

            ...(origin === "face-swap" ? { mediaType: "video" } : {}),

            createdAt: serverTimestamp(),
        }
    );
    return document.id;

}

export function subscribeToLibraryImages(
    userId: string,
    callback: (images: string[]) => void
) {

    const swapsRef = collection(
        db,
        "users",
        userId,
        "swaps"
    );

    const swapsQuery = query(
        swapsRef,
        orderBy("createdAt", "desc")
    );

    return onSnapshot(
        swapsQuery,
        (snapshot) => {

            const images = snapshot.docs
                .filter((doc) => {

                    const data = doc.data();

                    return (
                        !data.type ||
                        data.type === "face-swap"
                    );

                })
                .map(
                    (doc) =>
                        doc.data().imageUrl as string
                )
                .filter(Boolean)
                .slice(0, 6);

            callback(images);

        }
    );

}

export type LibraryItem = {

    id: string;

    imageUrl?: string;

    videoUrl?: string;

    taskId?: string;

    mediaType?: "image" | "video";

    type:
        | "face-swap"
        | "image-generation"
        | "video-generation";

    createdAt: any;

};

export function subscribeToLibrary(
    userId: string,
    callback: (items: LibraryItem[]) => void
) {

    const swapsRef = collection(
        db,
        "users",
        userId,
        "swaps"
    );

    const swapsQuery = query(
        swapsRef,
        orderBy("createdAt", "desc")
    );

    return onSnapshot(
        swapsQuery,
        (snapshot) => {

            const items: LibraryItem[] =
                snapshot.docs.map((doc) => {

                    const data = doc.data();

                    return {

                        id: doc.id,

                        imageUrl: data.imageUrl,

                        videoUrl: data.videoUrl,

                        taskId: data.taskId,

                        mediaType: data.mediaType === "image" || data.mediaType === "video" ? data.mediaType : undefined,

                        type: data.type || "face-swap",

                        createdAt: data.createdAt,

                    };

                });

            callback(items);

        }
    );
}


/** Origin stays face-swap; only explicit new media evidence enables its player. */
export function isLibraryVideo(item: LibraryItem): boolean {
    return item.type === "video-generation"
        || (item.type === "face-swap" && item.mediaType === "video" && !!item.videoUrl);
}

/** Read-only recovery for explicitly classified Face Swap videos; no legacy migration. */
export async function findFaceSwapVideo(userId: string, taskId: string): Promise<{ id: string; reference: string } | null> {
    const snapshot = await getDocs(query(collection(db, "users", userId, "swaps"),
        where("taskId", "==", taskId), limit(5)));
    for (const document of snapshot.docs) {
        const data = document.data();
        if (data.type === "face-swap" && data.mediaType === "video" && typeof data.videoUrl === "string" && data.videoUrl) {
            return { id: document.id, reference: data.videoUrl };
        }
    }
    return null;
}

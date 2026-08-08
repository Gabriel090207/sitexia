import {
    addDoc,
    collection,
    serverTimestamp,
    onSnapshot,
    query,
    orderBy,
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
    taskId: string
) {

    await addDoc(
        collection(
            db,
            "users",
            userId,
            "swaps"
        ),
        {
            videoUrl,

            taskId,

            type: "video-generation",

            createdAt: serverTimestamp(),
        }
    );

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

                        type: data.type || "face-swap",

                        createdAt: data.createdAt,

                    };

                });

            callback(items);

        }
    );
}


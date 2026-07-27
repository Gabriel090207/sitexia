import {
    doc,
    getDoc,
    serverTimestamp,
    setDoc,
} from "firebase/firestore";

import type { User } from "firebase/auth";

import db from "./firestore";

export async function createUserDocument(user: User) {

    const userRef = doc(db, "users", user.uid);

    const userSnapshot = await getDoc(userRef);

    if (userSnapshot.exists()) {
        return;
    }

    await setDoc(userRef, {

        uid: user.uid,

        email: user.email,

        displayName: user.displayName || "",

        photoURL: user.photoURL || "",

        plan: "free",

        credits: 0,

        createdAt: serverTimestamp(),

    });

}
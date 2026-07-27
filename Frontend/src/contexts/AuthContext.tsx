import {
    createContext,
    useContext,
    useEffect,
    useState,
} from "react";

import type { ReactNode } from "react";

import {
    onAuthStateChanged,
    signOut,
} from "firebase/auth";

import type { User } from "firebase/auth";

import auth from "../firebase/auth";

interface AuthContextType {
    user: User | null;
    loading: boolean;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>(
    {} as AuthContextType
);

interface AuthProviderProps {
    children: ReactNode;
}

export function AuthProvider({
    children,
}: AuthProviderProps) {

    const [user, setUser] = useState<User | null>(null);

    const [loading, setLoading] = useState(true);

    useEffect(() => {

        const unsubscribe = onAuthStateChanged(
            auth,
            (currentUser) => {

                setUser(currentUser);

                setLoading(false);

            }
        );

        return unsubscribe;

    }, []);

    async function logout() {

        await signOut(auth);

    }

    return (

        <AuthContext.Provider
            value={{
                user,
                loading,
                logout,
            }}
        >

            {children}

        </AuthContext.Provider>

    );

}

export function useAuth() {

    return useContext(AuthContext);

}
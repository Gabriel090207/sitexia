import { Navigate } from "react-router-dom";

import { useAuth } from "../contexts/AuthContext";

import type { ReactNode } from "react";

interface ProtectedRouteProps {
    children: ReactNode;
}

function ProtectedRoute({
    children,
}: ProtectedRouteProps) {

    const {
        user,
        loading,
    } = useAuth();

    if (loading) {

        return null;

    }

    if (!user) {

        return <Navigate to="/login" replace />;

    }

    return children;

}

export default ProtectedRoute;
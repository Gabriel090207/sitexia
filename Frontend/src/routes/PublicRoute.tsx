import { Navigate } from "react-router-dom";

import { useAuth } from "../contexts/AuthContext";

import type { ReactNode } from "react";

interface PublicRouteProps {
    children: ReactNode;
}

function PublicRoute({
    children,
}: PublicRouteProps) {

    const {
        user,
        loading,
    } = useAuth();

    if (loading) {

        return null;

    }

    if (user) {

        return <Navigate to="/" replace />;

    }

    return children;

}

export default PublicRoute;
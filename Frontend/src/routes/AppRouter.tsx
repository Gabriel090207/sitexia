import {
    Navigate,
    Route,
    Routes,
    useLocation,
} from "react-router-dom";

import MainLayout from "../layouts/MainLayout/MainLayout";

import ScrollToTop from "./ScrollToTop";

import Home from "../pages/Home/Home";
import FaceSwap from "../pages/FaceSwap/FaceSwap";
import VideoGeneration from "../pages/VideoGeneration/VideoGeneration";
import ImageGeneration from "../pages/ImageGeneration/ImageGeneration";
import Library from "../pages/Library/Library";

import Pricing from "../pages/Pricing/Pricing";
import Checkout from "../pages/Checkout/Checkout";

import Login from "../pages/Login/Login";

import Profile from "../pages/Profile/Profile";

import ProtectedRoute from "./ProtectedRoute";
import PublicRoute from "./PublicRoute";

interface LegacyRouteRedirectProps {
    to: string;
}

function LegacyRouteRedirect({
    to,
}: LegacyRouteRedirectProps) {
    const location = useLocation();

    return (
        <Navigate
            to={`${to}${location.search}`}
            replace
            state={location.state}
        />
    );
}

function AppRouter() {
    return (
        <>
            <ScrollToTop />

            <Routes>

            <Route element={<MainLayout />}>

                <Route
                    path="/"
                    element={<Home />}
                />

                <Route
                    path="/troca-de-rosto"
                    element={<FaceSwap />}
                />

                <Route
                    path="/geracao-de-video"
                    element={<VideoGeneration />}
                />

                <Route
                    path="/geracao-de-imagem"
                    element={<ImageGeneration />}
                />

                <Route
                    path="/biblioteca"
                    element={
                        <ProtectedRoute>
                            <Library />
                        </ProtectedRoute>
                    }
                />

                <Route
                    path="/creditos"
                    element={<Pricing />}
                />



                <Route
                    path="/finalizar-recarga"
                    element={
                        <ProtectedRoute>
                            <Checkout />
                        </ProtectedRoute>
                    }
                />


                <Route
                    path="/perfil"
                    element={
                        <ProtectedRoute>
                            <Profile />
                        </ProtectedRoute>
                    }
                />

               

                <Route
                    path="/entrar"
                    element={
                        <PublicRoute>
                            <Login />
                        </PublicRoute>
                    }
                />

                <Route
                    path="/face-swap"
                    element={<LegacyRouteRedirect to="/troca-de-rosto" />}
                />

                <Route
                    path="/video-generation"
                    element={<LegacyRouteRedirect to="/geracao-de-video" />}
                />

                <Route
                    path="/image-generation"
                    element={<LegacyRouteRedirect to="/geracao-de-imagem" />}
                />

                <Route
                    path="/library"
                    element={<LegacyRouteRedirect to="/biblioteca" />}
                />

                <Route
                    path="/pricing"
                    element={<LegacyRouteRedirect to="/creditos" />}
                />

                <Route
                    path="/checkout"
                    element={<LegacyRouteRedirect to="/finalizar-recarga" />}
                />

                <Route
                    path="/profile"
                    element={<LegacyRouteRedirect to="/perfil" />}
                />

                <Route
                    path="/login"
                    element={<LegacyRouteRedirect to="/entrar" />}
                />

            </Route>

            </Routes>

        </>
    );
}

export default AppRouter;

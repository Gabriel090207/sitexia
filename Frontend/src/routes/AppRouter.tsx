import { Route, Routes } from "react-router-dom";

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
                    path="/face-swap"
                    element={<FaceSwap />}
                />

                <Route
                    path="/video-generation"
                    element={<VideoGeneration />}
                />

                <Route
                    path="/image-generation"
                    element={<ImageGeneration />}
                />

                <Route
                    path="/library"
                    element={
                        <ProtectedRoute>
                            <Library />
                        </ProtectedRoute>
                    }
                />

                <Route
                    path="/pricing"
                    element={<Pricing />}
                />



                <Route
                    path="/checkout"
                    element={<Checkout />}
                />


                <Route
                    path="/profile"
                    element={
                        <ProtectedRoute>
                            <Profile />
                        </ProtectedRoute>
                    }
                />

               

                <Route
                    path="/login"
                    element={
                        <PublicRoute>
                            <Login />
                        </PublicRoute>
                    }
                />

            </Route>

            </Routes>

        </>
    );
}

export default AppRouter;
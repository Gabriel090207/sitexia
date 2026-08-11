import { useEffect, useState } from "react";

import {
    Menu,
    X,
    User,
    LogOut,
} from "lucide-react";

import {
    NavLink,
    useLocation,
    useNavigate,
} from "react-router-dom";

import { useAuth } from "../../contexts/AuthContext";

import Logo from "../../assets/images/logo.png";

import "./Header.css";

const getNavLinkClass = ({ isActive }: { isActive: boolean }) =>
    isActive
        ? "header-navigation-link header-navigation-link-active"
        : "header-navigation-link";

function Header() {

    const {
        user,
        logout,
    } = useAuth();

    const navigate = useNavigate();

    const location = useLocation();

    const [sidebarOpen, setSidebarOpen] = useState(false);

    useEffect(() => {

        setSidebarOpen(false);

    }, [location.pathname]);

    useEffect(() => {

        function handleEscape(event: KeyboardEvent) {

            if (event.key === "Escape") {

                setSidebarOpen(false);

            }

        }

        window.addEventListener(
            "keydown",
            handleEscape
        );

        return () => {

            window.removeEventListener(
                "keydown",
                handleEscape
            );

        };

    }, []);

    useEffect(() => {

        document.body.style.overflow = sidebarOpen
            ? "hidden"
            : "auto";

        return () => {

            document.body.style.overflow = "auto";

        };

    }, [sidebarOpen]);

    async function handleLogout() {

        await logout();

        navigate("/");

    }

    const avatarLetter =
        user?.email?.charAt(0).toUpperCase() ?? "";


    return (

        <>

            <header className="header">

                <div className="header-container">

                    <button
                        className="header-mobile-menu-button"
                        onClick={() => setSidebarOpen(true)}
                    >
                        <Menu size={28} />
                    </button>

                    <NavLink
                        to="/"
                        className="header-logo"
                    >

                        <img
                            src={Logo}
                            alt="Xia"
                            className="header-logo-image"
                        />

                    </NavLink>

                    <nav className="header-navigation">

                        <ul className="header-navigation-list">

                            <li>
                                <NavLink
                                    end
                                    to="/"
                                    className={getNavLinkClass}
                                >
                                    Início
                                </NavLink>
                            </li>

                            {user && (

                                <li>
                                    <NavLink
                                        to="/library"
                                        className={getNavLinkClass}
                                    >
                                        Biblioteca
                                    </NavLink>
                                </li>

                            )}

                            <li>

                                <NavLink
                                    to="/face-swap"
                                    className={getNavLinkClass}
                                >
                                    Face Swap
                                </NavLink>

                            </li>

                            <li>

                                <NavLink
                                    to="/video-generation"
                                    className={getNavLinkClass}
                                >
                                    Video Generation
                                </NavLink>

                            </li>

                            <li>

                                <NavLink
                                    to="/image-generation"
                                    className={getNavLinkClass}
                                >
                                    Image Generation
                                </NavLink>

                            </li>

                            <li>
                                <NavLink
                                    to="/pricing"
                                    className={getNavLinkClass}
                                >
                                    Planos
                                </NavLink>
                            </li>

                        </ul>

                    </nav>

                    <div className="header-actions">

                        {!user && (

                            <button
                                onClick={() => navigate("/login")}
                                className="header-register-button"
                            >
                                Entrar
                            </button>

                        )}

                        {user && (

                            <>

                                <button
                                    className="header-profile-button"
                                    onClick={() => navigate("/profile")}
                                >

                                    <User size={18} />

                                    Meu Perfil

                                </button>

                                {user.photoURL ? (

                                    <img
                                        src={user.photoURL}
                                        alt="Avatar"
                                        className="header-avatar-image"
                                    />

                                ) : (

                                    <div
                                        className="header-avatar-letter"
                                    >
                                        {avatarLetter}
                                    </div>

                                )}

                                

                                <button
                                    onClick={handleLogout}
                                    className="header-logout-button"
                                >

                                    <LogOut size={18} />

                                </button>

                            </>

                        )}

                    </div>

                </div>

            </header>

            <div
                className={`header-overlay ${
                    sidebarOpen
                        ? "header-overlay-open"
                        : ""
                }`}
                onClick={() => setSidebarOpen(false)}
            />

            <aside
                className={`header-sidebar ${
                    sidebarOpen
                        ? "header-sidebar-open"
                        : ""
                }`}
            >

                <button
                    className="header-sidebar-close"
                    onClick={() => setSidebarOpen(false)}
                >

                    <X size={28} />

                </button>

                <nav className="header-sidebar-navigation">

                    <NavLink to="/">
                        Início
                    </NavLink>

                    {user && (

                        <NavLink to="/library">
                            Biblioteca
                        </NavLink>

                    )}

                    <NavLink to="/face-swap">
                        Face Swap
                    </NavLink>

                    <NavLink to="/video-generation">
                        Video Generation
                    </NavLink>

                    <NavLink to="/image-generation">
                        Image Generation
                    </NavLink>

                    <NavLink to="/pricing">
                        Planos
                    </NavLink>

                </nav>

                {user && (

                    <div className="header-sidebar-footer">

                        <button
                            className="header-sidebar-profile-button"
                            onClick={() => navigate("/profile")}
                        >
                            <User size={18} />

                            Meu Perfil
                        </button>

                        

                    </div>

                )}

            </aside>

        </>

    );

}

export default Header;
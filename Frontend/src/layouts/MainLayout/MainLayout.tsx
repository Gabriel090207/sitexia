import { Outlet } from "react-router-dom";

import Header from "../../components/Header/Header";

import "./MainLayout.css";

function MainLayout() {
    return (
        <div className="main-layout">

            <Header />

            <main className="main-layout-content">
                <Outlet />
            </main>

        </div>
    );
}

export default MainLayout;
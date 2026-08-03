import "./Profile.css";

import {
    useEffect,
    useState,
} from "react";

import {
    Link,
    useNavigate,
} from "react-router-dom";

import {
    doc,
    getDoc,
    deleteDoc,
} from "firebase/firestore";

import {
    deleteUser,
    sendPasswordResetEmail,
} from "firebase/auth";

import {
    User,
    Mail,
    KeyRound,
    CreditCard,
    Coins,
    Trash2,
    CircleCheckBig,
    CircleAlert,
} from "lucide-react";

import auth from "../../firebase/auth";
import db from "../../firebase/firestore";
import { useAuth } from "../../contexts/AuthContext";

import {
    cancelSubscription,
} from "../../api/subscription";

interface UserData {

    uid: string;

    email: string;

    displayName: string;

    photoURL: string;

    plan: string;

    credits: number;

    subscription_status?: string;

    subscription_next_payment?: string;

    active_subscription?: string;

}

export default function Profile() {

    const navigate = useNavigate();

    const {
        user,
        loading,
    } = useAuth();

    const [userData, setUserData] =
        useState<UserData | null>(null);

    const [loadingData, setLoadingData] =
        useState(true);

    const [deleteModal, setDeleteModal] =
        useState(false);

    const [closingModal, setClosingModal] = useState(false);

    const [cancelSubscriptionModal, setCancelSubscriptionModal] =
        useState(false);

    const [closingCancelModal, setClosingCancelModal] =
        useState(false);

    const [toast, setToast] = useState({
        open: false,
        title: "",
        message: "",
        type: "success",
    });


    function showToast(
        title: string,
        message: string,
        type: "success" | "error"
    ) {

        setToast({
            open: true,
            title,
            message,
            type,
        });

        setTimeout(() => {

            setToast({
                open: false,
                title: "",
                message: "",
                type: "success",
            });

        }, 4000);

    }

    useEffect(() => {

        async function loadUser() {

            if (!user) {

                setLoadingData(false);

                return;

            }

            const userRef = doc(
                db,
                "users",
                user.uid
            );

            const snapshot =
                await getDoc(userRef);

            if (snapshot.exists()) {

                setUserData(
                    snapshot.data() as UserData
                );

            }

            setLoadingData(false);

        }

        loadUser();

    }, [user]);

    

    async function handlePasswordReset() {

        if (!user?.email) {
            return;
        }

        await sendPasswordResetEmail(
            auth,
            user.email
        );

       showToast(
            "Email enviado",
            "Verifique sua caixa de entrada para redefinir sua senha.",
            "success"
        );

    }

    async function handleDeleteAccount() {

        if (!user) {
            return;
        }

        try {

            await deleteDoc(
                doc(
                    db,
                    "users",
                    user.uid
                )
            );

            await deleteUser(user);

            navigate("/");

        } catch {

            showToast(
                "Não foi possível excluir",
                "Por segurança, faça login novamente antes de excluir sua conta.",
                "error"
            );

        }

    }


    async function handleCancelSubscription() {

        if (!user || !userData?.active_subscription) {

            return;

        }

        try {

            await cancelSubscription({

                subscription_id:
                    userData.active_subscription

            });


            setClosingCancelModal(true);

            setTimeout(() => {

                setCancelSubscriptionModal(false);

                setClosingCancelModal(false);

            }, 300);

            showToast(

                "Assinatura cancelada",

                "Seu plano foi cancelado com sucesso.",

                "success"

            );


            const snapshot = await getDoc(

                doc(

                    db,

                    "users",

                    user.uid

                )

            );

            if (snapshot.exists()) {

                setUserData(

                    snapshot.data() as UserData

                );

            }

        
        } catch {

            showToast(

                "Erro",

                "Não foi possível cancelar sua assinatura.",

                "error"

            );

        }

        

    }


    if (loading || loadingData) {

        return (

            <main className="profile">

                <div className="profile-loading">

                    Carregando...

                </div>

            </main>

        );

    }

    if (!user || !userData) {

        return null;

    }

    const isFreePlan =
        userData.plan === "free";


    function closeDeleteModal() {

        setClosingModal(true);

        setTimeout(() => {

            setDeleteModal(false);

            setClosingModal(false);

        }, 300);

    }

    return (

    <main className="profile">

        <div className="profile-container">

            <div className="profile-header">

                <h1>

                    Meu Perfil

                </h1>

                <p>

                    Gerencie sua conta e sua assinatura Xia.

                </p>

            </div>

            <div className="profile-grid">

                <section className="profile-card">

                    <h2>

                        Informações da Conta

                    </h2>

                    <div className="profile-avatar">

                        {

                            userData.photoURL ?

                                <img
                                    src={userData.photoURL}
                                    alt={userData.displayName}
                                />

                                :

                                <div className="profile-avatar-placeholder">

                                    {

                                        userData.displayName ?

                                            userData.displayName
                                                .charAt(0)
                                                .toUpperCase()

                                            :

                                            <User size={44} />

                                    }

                                </div>

                        }

                    </div>

                    <div className="profile-item">

                        <Mail size={18} />

                        <div>

                            <span>

                                Email

                            </span>

                            <strong>

                                {userData.email}

                            </strong>

                        </div>

                    </div>

                    <div className="profile-item ">

                        <KeyRound size={18} />

                        <div>

                            <span>

                                Senha

                            </span>

                            <button
                                className="profile-link-button"
                                onClick={handlePasswordReset}
                            >

                                Alterar senha

                            </button>

                        </div>

                    </div>

                    <button
                        className="profile-delete"
                        onClick={() =>
                            setDeleteModal(true)
                        }
                    >

                        <Trash2 size={18} />

                        Excluir conta

                    </button>

                </section>

                <section className="profile-card">

                    <h2>

                        Meu Plano

                    </h2>

                    <div className="profile-item">

                        <CreditCard size={38} />

                        <div>

                            <span>

                                Plano Atual

                            </span>

                            <strong>

                                {

                                    isFreePlan ?

                                        "Free"

                                        :

                                        userData.plan

                                }

                            </strong>

                        </div>

                    </div>

                    <div className="profile-item">

                        <Coins size={38} />

                        <div>

                            <span>

                                Créditos

                            </span>

                            <strong>

                                {userData.credits}

                            </strong>

                        </div>

                    </div>

                    {

                        isFreePlan ?

                            <>

                                <p className="profile-plan-text">

                                    Você ainda não possui um plano ativo.

                                </p>

                                <Link
                                    to="/pricing"
                                    className="profile-plan-button"
                                >

                                    Ver Planos

                                </Link>

                            </>

                            :

                            <>

                                <div className="profile-item">

                                    <div>

                                        <span>

                                            Próxima renovação

                                        </span>

                                        <strong>

                                            {

                                                userData.subscription_next_payment

                                                    ?

                                                    new Date(
                                                        userData.subscription_next_payment
                                                    ).toLocaleDateString(
                                                        "pt-BR"
                                                    )

                                                    :

                                                    "-"

                                            }

                                        </strong>

                                    </div>

                                </div>

                                <button
                                    className="profile-plan-button"
                                    onClick={() =>
                                        setCancelSubscriptionModal(true)
                                    }
                                >

                                    Cancelar Assinatura

                                </button>

                            </>

                    }

                </section>

            </div>

            {

                deleteModal &&

                <div
                    className={
                        closingModal
                            ? "profile-modal-overlay profile-modal-overlay-close"
                            : "profile-modal-overlay"
                    }
                >

                    <div
                        className={
                            closingModal
                                ? "profile-modal profile-modal-close"
                                : "profile-modal"
                        }
                    >

                        <h3>

                            Excluir conta

                        </h3>

                        <p>

                            Esta ação é permanente e todos os seus dados serão removidos.

                        </p>

                        <div className="profile-modal-actions">

                            <button
                                className="profile-cancel"
                                onClick={closeDeleteModal}
                            >

                                Cancelar

                            </button>

                            <button
                                className="profile-confirm"
                                onClick={handleDeleteAccount}
                            >

                                Excluir

                            </button>

                        </div>

                    </div>

                </div>

            }

        </div>


        {
            toast.open && (

                <div
                    className={
                        toast.type === "success"
                            ? "profile-toast"
                            : "profile-toast profile-toast-error"
                    }
                >

                    <div className="profile-toast-icon">

                        {
                            toast.type === "success"

                                ? <CircleCheckBig size={24} />

                                : <CircleAlert size={24} />
                        }

                    </div>

                    <div className="profile-toast-content">

                        <strong>

                            {toast.title}

                        </strong>

                        <span>

                            {toast.message}

                        </span>

                    </div>

                </div>

            )
        }


        {
            cancelSubscriptionModal &&

            <div
                className={
                    closingCancelModal
                        ? "profile-modal-overlay profile-modal-overlay-close"
                        : "profile-modal-overlay"
                }
            >

                <div
                    className={
                        closingCancelModal
                            ? "profile-modal profile-modal-close"
                            : "profile-modal"
                    }
                >

                    <h3>

                        Cancelar assinatura

                    </h3>

                    <p>

                        Ao cancelar sua assinatura você perderá imediatamente o acesso ao plano atual e seus créditos serão zerados. Esta ação não pode ser desfeita.

                    </p>

                    <div className="profile-modal-actions">

                        <button
                            className="profile-cancel"
                            onClick={() => {

                                setClosingCancelModal(true);

                                setTimeout(() => {

                                    setCancelSubscriptionModal(false);

                                    setClosingCancelModal(false);

                                }, 300);

                            }}
                        >

                            Cancelar

                        </button>

                        <button
                            className="profile-confirm"
                            onClick={handleCancelSubscription}
                        >

                            Cancelar Assinatura

                        </button>

                    </div>

                </div>

            </div>
        }

    </main>

);
}
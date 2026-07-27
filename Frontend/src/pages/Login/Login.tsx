import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff } from "lucide-react";
import GoogleIcon from "../../assets/images/google-icon.png";

import "./Login.css";

import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    GoogleAuthProvider,
    signInWithPopup,
} from "firebase/auth";

import { createUserDocument } from "../../firebase/users";

import { FirebaseError } from "firebase/app";

import auth from "../../firebase/auth";

const googleProvider = new GoogleAuthProvider();

function Login() {

const navigate = useNavigate();

const [showPassword, setShowPassword] = useState(false);

const [isRegister, setIsRegister] = useState(false);

const [showConfirmPassword, setShowConfirmPassword] = useState(false);

const [email, setEmail] = useState("");

const [password, setPassword] = useState("");

const [confirmPassword, setConfirmPassword] = useState("");

const [loading, setLoading] = useState(false);

const [emailError, setEmailError] = useState("");

const [passwordError, setPasswordError] = useState("");

const [confirmPasswordError, setConfirmPasswordError] = useState("");

const [formError, setFormError] = useState("");

const clearForm = () => {

    setEmail("");

    setPassword("");

    setConfirmPassword("");

    setEmailError("");

    setPasswordError("");

    setConfirmPasswordError("");

    setFormError("");

};

const handleSubmit = async (
    e: React.FormEvent<HTMLFormElement>
) => {

    e.preventDefault();

    setEmailError("");
    setPasswordError("");
    setConfirmPasswordError("");
    setFormError("");

    if (!email.trim()) {

        setEmailError("Digite seu e-mail.");

        return;

    }

    if (!password.trim()) {

        setPasswordError("Digite sua senha.");

        return;

    }

    if (isRegister && password.length < 6) {

        setPasswordError(
            "A senha deve conter pelo menos 6 caracteres."
        );

        return;

    }

    if (isRegister && !confirmPassword.trim()) {

        setConfirmPasswordError("Confirme sua senha.");

        return;

    }

    if (isRegister && password !== confirmPassword) {

        setConfirmPasswordError("As senhas não coincidem.");

        return;

    }

    if (isRegister) {

        try {

            setLoading(true);

            const userCredential = await createUserWithEmailAndPassword(
                auth,
                email,
                password
            );

            await createUserDocument(userCredential.user);

            clearForm();

            navigate("/");

        } catch (error) {

            const authError = error as FirebaseError;

            switch (authError.code) {

                case "auth/email-already-in-use":

                    setEmailError("Este e-mail já está cadastrado.");

                    break;

                case "auth/invalid-email":

                    setEmailError("Digite um e-mail válido.");

                    break;

                case "auth/weak-password":

                    setPasswordError("A senha deve conter pelo menos 6 caracteres.");

                    break;

                case "auth/network-request-failed":

                    setFormError("Verifique sua conexão com a internet.");

                    break;

                default:

                    setFormError("Não foi possível criar sua conta.");

                    console.error(authError);

                    break;

            }

        } finally {

            setLoading(false);

        }

        return;

    }

    try {

        setLoading(true);

        await signInWithEmailAndPassword(
            auth,
            email,
            password
        );

        clearForm();
        navigate("/");

    } catch (error) {

        const authError = error as FirebaseError;

        switch (authError.code) {

            case "auth/user-not-found":

                setEmailError("Nenhuma conta foi encontrada com este e-mail.");

                break;

            case "auth/invalid-credential":

                setPasswordError("E-mail ou senha incorretos.");

                break;

            case "auth/wrong-password":

                setPasswordError("Senha incorreta.");

                break;

            case "auth/invalid-email":

                setEmailError("Digite um e-mail válido.");

                break;

            case "auth/network-request-failed":

                setFormError("Verifique sua conexão com a internet.");

                break;

            default:

                setFormError("Não foi possível entrar na conta.");

                console.error(authError);

                break;

        }

    } finally {

        setLoading(false);

    }

};

const handleGoogleLogin = async () => {

    setFormError("");

    try {

        setLoading(true);

        const userCredential = await signInWithPopup(
            auth,
            googleProvider
        );

        await createUserDocument(userCredential.user);

        clearForm();

        navigate("/");

    } catch (error) {

        const authError = error as FirebaseError;

        switch (authError.code) {

            case "auth/account-exists-with-different-credential":

                setFormError(
                    "Este e-mail já está cadastrado. Entre usando sua senha."
                );

                break;

            case "auth/popup-closed-by-user":

                break;

            case "auth/popup-blocked":

                setFormError(
                    "O navegador bloqueou a janela de login."
                );

                break;

            case "auth/network-request-failed":

                setFormError(
                    "Verifique sua conexão com a internet."
                );

                break;

            default:

                setFormError(
                    "Não foi possível entrar com o Google."
                );

                console.error(authError);

                break;

        }

    } finally {

        setLoading(false);

    }

};

    return (
        <section className="login">

            <div className="login-container">

                <div className="login-card">

                    <div className="login-header">

                        <h1 className="login-title">
                            {isRegister
                                ? "Criar sua conta"
                                : "Entrar na sua conta"}
                        </h1>

                        <p className="login-description">
                            {isRegister
                                ? "Crie sua conta e comece a criar vídeos, imagens e Face Swaps com inteligência artificial."
                                : "Continue criando vídeos, imagens e Face Swaps com inteligência artificial."}
                        </p>

                    </div>

                    <form
                        className="login-form"
                        onSubmit={handleSubmit}
                    >

                        <div className="login-field">

                            <label className="login-label">
                                Email
                            </label>

                            <input
                                type="email"
                                className="login-input"
                                placeholder="Digite seu email"
                                value={email}
                                onChange={(e) => {

                                    setEmail(e.target.value);

                                    setEmailError("");

                                }}
                            />

                            {emailError && (
                                <p className="login-error">
                                    {emailError}
                                </p>
                            )}

                        </div>

                        <div className="login-field">

                            <label className="login-label">
                                Senha
                            </label>

                            <div className="login-password-wrapper">

                                <input
                                    type={showPassword ? "text" : "password"}
                                    className="login-input"
                                    placeholder="Digite sua senha"
                                    value={password}
                                    onChange={(e) => {

                                        setPassword(e.target.value);

                                        setPasswordError("");

                                    }}
                                />

                                <button
                                    type="button"
                                    className="login-password-toggle"
                                    onClick={() => setShowPassword(!showPassword)}
                                >
                                    {showPassword ? (
                                        <EyeOff size={18} />
                                    ) : (
                                        <Eye size={18} />
                                    )}
                                </button>

                            </div>

                            {passwordError && (
                                <p className="login-error">
                                    {passwordError}
                                </p>
                            )}

                            {isRegister && (

                                <p className="login-password-info">
                                    A senha deve conter pelo menos 6 caracteres.
                                </p>

                            )}

                        </div>

                        {isRegister && (

                            <div className="login-field">

                                <label className="login-label">
                                    Confirmar senha
                                </label>

                                

                                <div className="login-password-wrapper">

                                    <input
                                        type={showConfirmPassword ? "text" : "password"}
                                        className="login-input"
                                        placeholder="Confirme sua senha"
                                        value={confirmPassword}
                                        onChange={(e) => {

                                            setConfirmPassword(e.target.value);

                                            setConfirmPasswordError("");

                                        }}
                                    />

                                    <button
                                        type="button"
                                        className="login-password-toggle"
                                        onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                                    >
                                        {showConfirmPassword ? (
                                            <EyeOff size={18} />
                                        ) : (
                                            <Eye size={18} />
                                        )}
                                    </button>

                                </div>

                                {confirmPasswordError && (
                                    <p className="login-error">
                                        {confirmPasswordError}
                                    </p>
                                )}



                            </div>

                        )}


                        {formError && (
                            <p className="login-error">
                                {formError}
                            </p>
                        )}

                        <button
                            type="submit"
                            className="login-submit-button"
                            disabled={loading}
                        >
                            {loading
                                ? "Carregando..."
                                : isRegister
                                    ? "Criar conta"
                                    : "Entrar"}
                        </button>

                    </form>

                    <div className="login-divider">

                        <span className="login-divider-line"></span>

                        <span className="login-divider-text">
                            ou
                        </span>

                        <span className="login-divider-line"></span>

                    </div>

                    <button
                        type="button"
                        className="login-google-button"
                        onClick={handleGoogleLogin}
                        disabled={loading}
                    >

                        <img
                            src={GoogleIcon}
                            alt="Google"
                            className="login-google-icon"
                        />

                        <span className="login-google-text">
                            Continuar com Google
                        </span>

                    </button>

                    <div className="login-footer">

                    <span className="login-footer-text">

                        {isRegister
                            ? "Já possui uma conta?"
                            : "Não possui uma conta?"}

                    </span>

                    <button
                        type="button"
                        className="login-footer-link"
                        onClick={() => {

                            clearForm();

                            setIsRegister(!isRegister);

                            window.scrollTo(0, 0);

                        }}
                    >

                        {isRegister
                            ? "Entrar"
                            : "Registrar-me"}

                    </button>

                </div>

                </div>

            </div>

        </section>
    );
}

export default Login;
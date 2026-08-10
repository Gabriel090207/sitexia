import { Link } from "react-router-dom";

import Logo from "../../assets/images/logo.png";

import { Headphones } from "lucide-react";

import "./Footer.css";

function Footer() {

    return (

        <footer className="footer">

            <div className="footer-container">

                <div className="footer-main">

                    <div className="footer-brand">

                        <Link
                            to="/"
                            className="footer-logo"
                        >
                            <img
                                src={Logo}
                                alt="Xia"
                                className="footer-logo-image"
                            />
                        </Link>

                        <p className="footer-description">
                            Crie imagens, vídeos e Face Swaps com
                            inteligência artificial em uma única plataforma.
                        </p>

                    </div>

                    <div className="footer-navigation">

                        <div className="footer-column">

                            <h3 className="footer-column-title">
                                Ferramentas
                            </h3>

                            <Link to="/face-swap">
                                Face Swap
                            </Link>

                            <Link to="/video-generation">
                                Video Generation
                            </Link>

                            <Link to="/image-generation">
                                Image Generation
                            </Link>

                        </div>

                        <div className="footer-column">

                            <h3 className="footer-column-title">
                                Plataforma
                            </h3>

                            <Link to="/">
                                Início
                            </Link>

                            <Link to="/pricing">
                                Planos
                            </Link>

                            <Link to="/library">
                                Biblioteca
                            </Link>

                        </div>

                        <div className="footer-column">

                            <h3 className="footer-column-title">
                                Suporte
                            </h3>

                            <a
                                href="mailto:Contato.xia@outlook.com"
                                className="footer-support-link"
                            >
                                <Headphones
                                    size={17}
                                    strokeWidth={2}
                                />

                                <span>
                                    Contato
                                </span>
                            </a>

                        </div>

                    </div>

                </div>

                <div className="footer-bottom">

                    <p className="footer-copyright">
                        © {new Date().getFullYear()} Xia. Todos os direitos reservados.
                    </p>

                </div>

            </div>

        </footer>

    );

}

export default Footer;
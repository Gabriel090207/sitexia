import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";

import "./ToolCard.css";

interface ToolCardProps {
    icon: React.ReactNode;
    title: string;
    description: string;
    link: string;
}

function ToolCard({
    icon,
    title,
    description,
    link,
}: ToolCardProps) {
    return (
        <Link
            to={link}
            className="tool-card"
        >
            <div className="tool-card-icon">
                {icon}
            </div>

            <h3 className="tool-card-title">
                {title}
            </h3>

            <p className="tool-card-description">
                {description}
            </p>

            <div className="tool-card-footer">

                <span className="tool-card-link-text">
                    Experimentar
                </span>

                <ArrowRight
                    size={18}
                    className="tool-card-link-icon"
                />

            </div>
        </Link>
    );
}

export default ToolCard;
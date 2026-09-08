import Hero from "../../components/Hero/Hero";
import AITools from "../../components/AITools/AITools";

import "./Home.css";

function Home() {
    return (
        <main className="home">

            <AITools />

            <Hero />

        </main>
    );
}

export default Home;
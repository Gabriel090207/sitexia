import axios from "axios";

import auth from "../firebase/auth";

const api = axios.create({

    baseURL: import.meta.env.VITE_API_URL

});

api.interceptors.request.use(async (config) => {

    const currentUser = auth.currentUser;

    if (currentUser) {

        const idToken = await currentUser.getIdToken();

        config.headers.set(
            "Authorization",
            `Bearer ${idToken}`
        );

    }

    return config;

});

export default api;

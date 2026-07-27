import { initializeApp } from "firebase/app";

const firebaseConfig = {
  apiKey: "AIzaSyDbnhv5WkgT1NVtCyk5ZgNQqkxQVOEOHvQ",
  authDomain: "sitexia-database.firebaseapp.com",
  projectId: "sitexia-database",
  storageBucket: "sitexia-database.firebasestorage.app",
  messagingSenderId: "231872317484",
  appId: "1:231872317484:web:53e5f53a61aec33f8b2989",
  measurementId: "G-GNQX8L8XLW"
};

const app = initializeApp(firebaseConfig);

export default app;
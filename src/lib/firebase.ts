import { initializeApp, getApps } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCf20Lmmp_Vuug21miSiruAdzYKKMIC8Cw",
  authDomain: "ikometintern.firebaseapp.com",
  projectId: "ikometintern",
  storageBucket: "ikometintern.firebasestorage.app",
  messagingSenderId: "1003958611610",
  appId: "1:1003958611610:web:da9fa30bcb739a5a7c3923"
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
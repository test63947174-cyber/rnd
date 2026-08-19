import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { 
    getDatabase, 
    ref, 
    get, 
    update, 
    set, 
    push, 
    runTransaction, 
    onValue,
    remove,
    query,
    orderByChild,
    equalTo
} from "firebase/database";

// ============================================================
// 🔥 NEW FIREBASE CONFIG (rwebsite-e031b)
// ============================================================
const firebaseConfig = {
    apiKey: "AIzaSyDsuqsmiwIG3Ey57MR19tr_8wJQRQ3_W64",
    authDomain: "rwebsite-e031b.firebaseapp.com",
    databaseURL: "https://rwebsite-e031b-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "rwebsite-e031b",
    storageBucket: "rwebsite-e031b.firebasestorage.app",
    messagingSenderId: "376966041558",
    appId: "1:376966041558:web:02bc9062ec182590275e77",
    measurementId: "G-0T1FREXHD3"
};

console.log('✅ Firebase initialized with NEW config (rwebsite-e031b)');

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

export { 
    auth, 
    db, 
    ref, 
    get, 
    update, 
    set, 
    push, 
    runTransaction, 
    onValue,
    remove,
    query,
    orderByChild,
    equalTo
};
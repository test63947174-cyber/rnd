\// ============================================================
// 🔥 FIREBASE CONFIG (rwebsite-e031b)
// ============================================================
import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithCustomToken,
  sendPasswordResetEmail,
  signOut,
} from "firebase/auth";
import { getDatabase, ref, get } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyDsuqsmiwIG3Ey57MR19tr_8wJQRQ3_W64",
  authDomain: "rwebsite-e031b.firebaseapp.com",
  databaseURL: "https://rwebsite-e031b-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "rwebsite-e031b",
  storageBucket: "rwebsite-e031b.firebasestorage.app",
  messagingSenderId: "376966041558",
  appId: "1:376966041558:web:02bc9062ec182590275e77",
  measurementId: "G-0T1FREXHD3",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const provider = new GoogleAuthProvider();

// ⚠️ अपना backend URL यहाँ डालें (deploy के बाद)
const BACKEND_URL = "https://your-backend-url.com";

// ============================================================
// 🍞 TOAST
// ============================================================
function showToast(message, type = "success") {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast-custom ${type}`;
  const icon = type === "success" ? "bi-check-circle-fill text-success" : "bi-exclamation-triangle-fill text-danger";
  toast.innerHTML = `<i class="bi ${icon}"></i><span class="toast-msg">${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100%)";
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// ============================================================
// 🔐 WEBAUTHN HELPERS
// ============================================================
function bufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlToBuffer(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
function isWebAuthnSupported() {
  return window.PublicKeyCredential !== undefined;
}

// ============================================================
// 🔐 SET UP PASSKEY (after password login)
// ============================================================
async function setupPasskey() {
  const user = auth.currentUser;
  if (!user) {
    showToast("❌ Please login with password first.", "error");
    return false;
  }
  if (!isWebAuthnSupported()) {
    showToast("❌ This device/browser does not support Passkeys.", "error");
    return false;
  }

  try {
    // 1. Get registration options from backend
    const beginRes = await fetch(`${BACKEND_URL}/api/webauthn/register/begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || user.email,
      }),
    });
    const options = await beginRes.json();
    if (!beginRes.ok) throw new Error(options.error || "Begin failed");

    // 2. Convert challenge and user.id from base64url
    options.challenge = base64urlToBuffer(options.challenge);
    options.user.id = base64urlToBuffer(options.user.id);
    if (options.excludeCredentials) {
      options.excludeCredentials = options.excludeCredentials.map((c) => ({
        ...c,
        id: base64urlToBuffer(c.id),
      }));
    }

    // 3. Create credential via device biometric
    const credential = await navigator.credentials.create({ publicKey: options });
    if (!credential) throw new Error("Credential creation failed");

    // 4. Send to backend for verification + storage
    const attestationResponse = {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        attestationObject: bufferToBase64url(credential.response.attestationObject),
        clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };

    const finishRes = await fetch(`${BACKEND_URL}/api/webauthn/register/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: user.uid, credential: attestationResponse }),
    });
    const finishData = await finishRes.json();
    if (!finishRes.ok || !finishData.verified) {
      throw new Error(finishData.error || "Verification failed");
    }

    showToast("✅ Fingerprint / Passkey successfully set up!", "success");
    return true;
  } catch (err) {
    console.error("Passkey setup error:", err);
    if (err.name === "NotAllowedError") {
      showToast("❌ Setup cancelled or not allowed.", "error");
    } else if (err.name === "InvalidStateError") {
      showToast("⚠️ This device already has a passkey for this account.", "error");
    } else {
      showToast("❌ " + (err.message || "Passkey setup failed"), "error");
    }
    return false;
  }
}

// ============================================================
// 🔐 LOGIN WITH PASSKEY
// ============================================================
async function loginWithPasskey() {
  if (!isWebAuthnSupported()) {
    showToast("❌ This device/browser does not support Passkeys.", "error");
    return;
  }

  // Ask user for email (needed to fetch their registered credentials)
  const email = document.getElementById("loginEmail").value.trim() ||
                prompt("Enter your email to login with Passkey:");
  if (!email) return;

  try {
    // 1. Get authentication options from backend
    const beginRes = await fetch(`${BACKEND_URL}/api/webauthn/login/begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const options = await beginRes.json();
    if (!beginRes.ok) throw new Error(options.error || "Begin failed");

    // 2. Convert challenge and allowCredentials
    options.challenge = base64urlToBuffer(options.challenge);
    if (options.allowCredentials) {
      options.allowCredentials = options.allowCredentials.map((c) => ({
        ...c,
        id: base64urlToBuffer(c.id),
      }));
    }

    // 3. Get assertion via device biometric
    const assertion = await navigator.credentials.get({ publicKey: options });
    if (!assertion) throw new Error("Authentication failed");

    // 4. Send to backend for verification
    const assertionResponse = {
      id: assertion.id,
      rawId: bufferToBase64url(assertion.rawId),
      type: assertion.type,
      response: {
        authenticatorData: bufferToBase64url(assertion.response.authenticatorData),
        clientDataJSON: bufferToBase64url(assertion.response.clientDataJSON),
        signature: bufferToBase64url(assertion.response.signature),
        userHandle: assertion.response.userHandle
          ? bufferToBase64url(assertion.response.userHandle)
          : null,
      },
      clientExtensionResults: assertion.getClientExtensionResults(),
    };

    const finishRes = await fetch(`${BACKEND_URL}/api/webauthn/login/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, assertion: assertionResponse }),
    });
    const finishData = await finishRes.json();
    if (!finishRes.ok || !finishData.verified) {
      throw new Error(finishData.error || "Verification failed");
    }

    // 5. Sign in to Firebase with custom token
    await signInWithCustomToken(auth, finishData.customToken);
    showToast("✅ Passkey verified! Logging in...", "success");
    // onAuthStateChanged will redirect to dashboard
  } catch (err) {
    console.error("Passkey login error:", err);
    if (err.name === "NotAllowedError") {
      showToast("❌ Login cancelled.", "error");
    } else {
      showToast("❌ " + (err.message || "Passkey login failed"), "error");
    }
  }
}

// ============================================================
// 🎨 UI STATE
// ============================================================
function updatePasskeyUI(user) {
  const section = document.getElementById("passkeySection");
  if (!section) return;

  if (!user) {
    // Not logged in — show passkey login button (assumes user has previously set up)
    section.innerHTML = `
      <button id="passkeyLoginBtn" class="passkey-btn">
        <i class="bi bi-fingerprint"></i> Login with Fingerprint / Passkey
      </button>
    `;
    document.getElementById("passkeyLoginBtn").addEventListener("click", loginWithPasskey);
    return;
  }

  // Logged in — check if passkey exists (via backend or RTDB)
  // We use RTDB: users/{uid}/passkeys
  get(ref(db, `users/${user.uid}/passkeys`)).then((snap) => {
    const hasKey = snap.exists() && Object.keys(snap.val()).length > 0;
    if (hasKey) {
      section.innerHTML = `
        <button id="passkeyLoginBtn" class="passkey-btn">
          <i class="bi bi-fingerprint"></i> Login with Fingerprint / Passkey
        </button>
      `;
      document.getElementById("passkeyLoginBtn").addEventListener("click", loginWithPasskey);
    } else {
      section.innerHTML = `
        <button id="setupPasskeyBtnInline" class="passkey-btn">
          <i class="bi bi-fingerprint"></i> Set Up Fingerprint / Passkey
        </button>
      `;
      document.getElementById("setupPasskeyBtnInline").addEventListener("click", async () => {
        const ok = await setupPasskey();
        if (ok && auth.currentUser) updatePasskeyUI(auth.currentUser);
      });
    }
  });
}

// ============================================================
// 🪟 SETUP PROMPT MODAL
// ============================================================
function showSetupPrompt() {
  const modal = document.getElementById("setupPromptModal");
  modal.classList.add("active");

  document.getElementById("setupPasskeyBtn").onclick = async () => {
    modal.classList.remove("active");
    const ok = await setupPasskey();
    if (ok && auth.currentUser) updatePasskeyUI(auth.currentUser);
  };
  document.getElementById("maybeLaterBtn").onclick = () => modal.classList.remove("active");
}

// ============================================================
// 🔄 AUTH STATE
// ============================================================
onAuthStateChanged(auth, async (user) => {
  if (user) {
    localStorage.setItem("rnd_last_email", user.email || "");
    try {
      const snapshot = await get(ref(db, "users/" + user.uid));
      if (snapshot.exists() && snapshot.val().banned) {
        showToast("❌ Your account has been banned.", "error");
        await signOut(auth);
        return;
      }
      // Check passkeys
      const passSnap = await get(ref(db, `users/${user.uid}/passkeys`));
      const hasKey = passSnap.exists() && Object.keys(passSnap.val()).length > 0;

      if (!hasKey && sessionStorage.getItem("rnd_prompted") !== "1") {
        // First time after this login — show setup prompt
        sessionStorage.setItem("rnd_prompted", "1");
        showSetupPrompt();
      } else {
        window.location.href = "dashboard.html";
      }
    } catch (e) {
      console.error(e);
      window.location.href = "dashboard.html";
    }
  } else {
    updatePasskeyUI(null);
  }
});

// ============================================================
// EMAIL/PASSWORD LOGIN
// ============================================================
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("loginEmail").value.trim();
  const pass = document.getElementById("loginPassword").value;
  const btn = document.getElementById("loginBtn");

  if (!email || !pass) { showToast("❌ Please enter email and password", "error"); return; }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Signing in...';

  try {
    sessionStorage.removeItem("rnd_prompted");
    await signInWithEmailAndPassword(auth, email, pass);
    // onAuthStateChanged will handle redirect / setup prompt
  } catch (err) {
    console.error("Login error:", err);
    let msg = "❌ Invalid email or password.";
    if (err.code === "auth/user-not-found") msg = "❌ No account found with this email.";
    else if (err.code === "auth/wrong-password") msg = "❌ Incorrect password.";
    else if (err.code === "auth/too-many-requests") msg = "❌ Too many attempts. Try later.";
    showToast(msg, "error");
    btn.disabled = false;
    btn.innerHTML = 'Sign In <i class="bi bi-arrow-right ms-2"></i>';
  }
});

// ============================================================
// GOOGLE LOGIN
// ============================================================
document.getElementById("googleLoginBtn").addEventListener("click", async () => {
  const btn = document.getElementById("googleLoginBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Loading...';
  try {
    sessionStorage.removeItem("rnd_prompted");
    await signInWithPopup(auth, provider);
  } catch (err) {
    console.error("Google login error:", err);
    showToast("❌ " + (err.message || "Google sign in failed"), "error");
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-google me-2"></i> Sign in with Google';
  }
});

// ============================================================
// FORGOT PASSWORD
// ============================================================
document.getElementById("forgotPasswordLink").addEventListener("click", async (e) => {
  e.preventDefault();
  const email = prompt("Enter your email address to receive password reset link:");
  if (email) {
    try {
      await sendPasswordResetEmail(auth, email);
      showToast("✅ Password reset link sent to " + email, "success");
    } catch (err) {
      showToast("❌ " + (err.message || "Failed to send reset email"), "error");
    }
  }
});
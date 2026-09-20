// ============================================================
// 🔥 FIREBASE CONFIG (rwebsite-e031b)
// ============================================================
import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  sendPasswordResetEmail,
  signOut,
} from "firebase/auth";
import { getDatabase, ref, get, set } from "firebase/database";

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

// RP (Relying Party) name — browser prompt में दिखेगा
const RP_NAME = "RND Staking";

// ============================================================
// 🍞 TOAST
// ============================================================
function showToast(message, type = "success") {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast-custom ${type}`;
  const icon =
    type === "success"
      ? "bi-check-circle-fill text-success"
      : "bi-exclamation-triangle-fill text-danger";
  toast.innerHTML = `<i class="bi ${icon}"></i><span class="toast-msg">${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100%)";
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// ============================================================
// 🔐 BASE64 HELPERS
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
// 🔐 LOCAL CREDENTIAL STORAGE (per browser)
// ============================================================
const STORAGE_KEY = "rnd_passkeys";

function getStoredCredentials() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCredential(cred) {
  const list = getStoredCredentials();
  list.push(cred);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function hasAnyCredentialForEmail(email) {
  return getStoredCredentials().some((c) => c.email === email);
}

function getCredentialsForEmail(email) {
  return getStoredCredentials().filter((c) => c.email === email);
}

// ============================================================
// 🔐 SET UP PASSKEY — runs after password login only
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
    // Challenge generate करें
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);

    const userId = new TextEncoder().encode(user.uid);

    const options = {
      publicKey: {
        challenge: challenge,
        rp: {
          name: RP_NAME,
          // Firebase Auth domain — same-origin trick
          id: window.location.hostname,
        },
        user: {
          id: userId,
          name: user.email || user.uid,
          displayName: user.displayName || user.email || user.uid,
        },
        pubKeyCredParams: [
          { alg: -7, type: "public-key" },   // ES256
          { alg: -257, type: "public-key" }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "preferred",
        },
        timeout: 60000,
        attestation: "none",
      },
    };

    // Device biometric prompt
    const credential = await navigator.credentials.create(options);
    if (!credential) throw new Error("Credential creation failed");

    // Save locally (no fingerprint data — only credential ID)
    const credData = {
      credentialId: bufferToBase64url(credential.rawId),
      email: user.email,
      uid: user.uid,
      createdAt: Date.now(),
      deviceName: navigator.userAgent.includes("Mobile")
        ? "Mobile Device"
        : "Desktop / Laptop",
    };
    saveCredential(credData);

    // Firebase में भी reference save करें (backup)
    try {
      await set(
        ref(db, `users/${user.uid}/passkeys/${credData.credentialId}`),
        {
          credentialId: credData.credentialId,
          createdAt: credData.createdAt,
          deviceName: credData.deviceName,
        }
      );
    } catch (e) {
      console.warn("RTDB save skipped:", e.message);
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

  // Email लें input से
  const emailInput = document.getElementById("loginEmail");
  let email = emailInput ? emailInput.value.trim() : "";
  if (!email) {
    email = prompt("Enter your email to login with Passkey:") || "";
  }
  if (!email) return;

  // इस browser में इस email के credentials हैं?
  const creds = getCredentialsForEmail(email);
  if (creds.length === 0) {
    showToast(
      "⚠️ No passkey found on this device. Please login with password first.",
      "error"
    );
    return;
  }

  // ⚠️ Pure client-side limitation:
  // Browser session पहले से active होना चाहिए (Firebase persistence).
  // अगर active है → सीधे dashboard
  // अगर नहीं है → password fallback

  // Pehle biometric verify करें
  try {
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);

    const allowCredentials = creds.map((c) => ({
      id: base64urlToBuffer(c.credentialId),
      type: "public-key",
      transports: ["internal"],
    }));

    const options = {
      publicKey: {
        challenge: challenge,
        rpId: window.location.hostname,
        allowCredentials,
        userVerification: "required",
        timeout: 60000,
      },
    };

    const assertion = await navigator.credentials.get(options);
    if (!assertion) throw new Error("Verification failed");

    // Biometric सफल — अब Firebase session check करें
    if (auth.currentUser && auth.currentUser.email === email) {
      // Session active है — सीधे dashboard
      showToast("✅ Passkey verified! Logging in...", "success");
      setTimeout(() => {
        window.location.href = "dashboard.html";
      }, 600);
    } else {
      // Session expired — password चाहिए
      showToast(
        "⚠️ Session expired. Please login with password (one time).",
        "error"
      );
    }
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
    // Not logged in — show passkey login button
    section.innerHTML = `
      <button id="passkeyLoginBtn" class="passkey-btn" type="button">
        <i class="bi bi-fingerprint"></i> Login with Fingerprint / Passkey
      </button>
    `;
    document
      .getElementById("passkeyLoginBtn")
      .addEventListener("click", loginWithPasskey);
    return;
  }

  // Logged in — check if this browser has passkey for this user
  const hasKey = hasAnyCredentialForEmail(user.email);

  if (hasKey) {
    section.innerHTML = `
      <button id="passkeyLoginBtn" class="passkey-btn" type="button">
        <i class="bi bi-fingerprint"></i> Login with Fingerprint / Passkey
      </button>
    `;
    document
      .getElementById("passkeyLoginBtn")
      .addEventListener("click", loginWithPasskey);
  } else {
    section.innerHTML = `
      <button id="setupPasskeyBtnInline" class="passkey-btn" type="button">
        <i class="bi bi-fingerprint"></i> Set Up Fingerprint / Passkey
      </button>
    `;
    document
      .getElementById("setupPasskeyBtnInline")
      .addEventListener("click", async () => {
        const ok = await setupPasskey();
        if (ok && auth.currentUser) updatePasskeyUI(auth.currentUser);
      });
  }
}

// ============================================================
// 🪟 SETUP PROMPT MODAL
// ============================================================
function showSetupPrompt() {
  const modal = document.getElementById("setupPromptModal");
  if (!modal) return;
  modal.classList.add("active");

  document.getElementById("setupPasskeyBtn").onclick = async () => {
    modal.classList.remove("active");
    const ok = await setupPasskey();
    if (ok && auth.currentUser) updatePasskeyUI(auth.currentUser);
  };

  document.getElementById("maybeLaterBtn").onclick = () => {
    modal.classList.remove("active");
  };
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

      // अगर passkey setup नहीं है — prompt दिखाएँ (सिर्फ एक बार per session)
      if (
        !hasAnyCredentialForEmail(user.email) &&
        sessionStorage.getItem("rnd_prompted") !== "1"
      ) {
        sessionStorage.setItem("rnd_prompted", "1");
        showSetupPrompt();
      } else {
        window.location.href = "dashboard.html";
      }
    } catch (e) {
      console.error("Auth check error:", e);
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

  if (!email || !pass) {
    showToast("❌ Please enter email and password", "error");
    return;
  }

  btn.disabled = true;
  btn.innerHTML =
    '<span class="spinner-border spinner-border-sm me-2"></span>Signing in...';

  try {
    sessionStorage.removeItem("rnd_prompted");
    await signInWithEmailAndPassword(auth, email, pass);
    // onAuthStateChanged handle करेगा
  } catch (err) {
    console.error("Login error:", err);
    let msg = "❌ Invalid email or password.";
    if (err.code === "auth/user-not-found")
      msg = "❌ No account found with this email.";
    else if (err.code === "auth/wrong-password")
      msg = "❌ Incorrect password.";
    else if (err.code === "auth/too-many-requests")
      msg = "❌ Too many attempts. Try later.";
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
  btn.innerHTML =
    '<span class="spinner-border spinner-border-sm me-2"></span>Loading...';
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
document
  .getElementById("forgotPasswordLink")
  .addEventListener("click", async (e) => {
    e.preventDefault();
    const email = prompt(
      "Enter your email address to receive password reset link:"
    );
    if (email) {
      try {
        await sendPasswordResetEmail(auth, email);
        showToast("✅ Password reset link sent to " + email, "success");
      } catch (err) {
        showToast(
          "❌ " + (err.message || "Failed to send reset email"),
          "error"
        );
      }
    }
  });

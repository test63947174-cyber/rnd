// ============================================================
// RND STAKING - REGISTER.JS (v3 - low Firebase usage)
// ============================================================
// v2 की सारी खूबियाँ वैसी ही हैं। v3 में सिर्फ़ ये बदला:
// ✅ Referrer / upline ढूँढते समय पूरा user node डाउनलोड नहीं होता,
//    सिर्फ़ referralCode, referredBy, email (3 छोटे fields) पढ़े जाते हैं
// ✅ पुराने short code / username वाली query में limitToFirst(1)
// ⚠️ Firebase Rules में "usernames" नोड ज़रूरी है (इसी की वजह से permission_denied आ रहा था)
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, createUserWithEmailAndPassword, updateProfile, deleteUser } from "firebase/auth";
import { getDatabase, ref, get, update, query, orderByChild, equalTo, limitToFirst, increment } from "firebase/database";

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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

const MAX_LEVELS = 5;

// ============================================================
// TOAST SYSTEM (innerHTML में user text नहीं डालते)
// ============================================================
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;

    const icon = document.createElement('i');
    icon.className = 'bi ' + (type === 'success'
        ? 'bi-check-circle-fill text-success'
        : 'bi-exclamation-triangle-fill text-danger');

    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = message;

    toast.appendChild(icon);
    toast.appendChild(msg);
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 6000);
}

// ============================================================
// HELPERS
// ============================================================
function sanitizeName(raw) {
    return (raw || '')
        .replace(/[<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
}

function isValidFirebaseKey(key) {
    return typeof key === 'string' && key.length > 0 && !/[.#$\[\]\/]/.test(key);
}

function extractRefCode(raw) {
    let value = (raw || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) {
        try {
            const u = new URL(value);
            const r = u.searchParams.get('ref');
            if (r) value = r.trim();
        } catch (_) { /* ignore */ }
    }
    return value;
}

function appError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

// ============================================================
// REFERRAL FROM URL
// ============================================================
let referralCodeFromURL = '';
const urlParams = new URLSearchParams(window.location.search);
const refFromURL = urlParams.get('ref');

if (refFromURL) {
    referralCodeFromURL = refFromURL.trim();
    document.getElementById('regRef').value = referralCodeFromURL;
    document.getElementById('referralNoticeText').textContent = '✅ Referral code auto-filled from link!';
    document.getElementById('referralNotice').className = 'referral-notice active';
}

document.getElementById('regRef').addEventListener('input', function () {
    const val = this.value.trim();
    const noticeText = document.getElementById('referralNoticeText');
    const notice = document.getElementById('referralNotice');
    if (val) {
        noticeText.textContent = '📌 Referral code: ' + val;
        notice.className = 'referral-notice active';
    } else {
        noticeText.textContent = "Enter referrer's User ID if you have one";
        notice.className = 'referral-notice';
    }
});

// ============================================================
// REFERRER LOOKUP (हल्का: पूरा node नहीं, सिर्फ़ ज़रूरी fields)
// - मिल गया   => { uid, data: { referralCode, referredBy } }
// - नहीं मिला => null
// - network/permission error => THROW
// ============================================================
async function resolveUser(identifier) {
    const id = (identifier || '').trim();
    if (!id) return null;

    // 1) सीधे UID से — सिर्फ़ 3 छोटे fields
    if (isValidFirebaseKey(id)) {
        const [codeS, byS, emailS] = await Promise.all([
            get(ref(db, `users/${id}/referralCode`)),
            get(ref(db, `users/${id}/referredBy`)),
            get(ref(db, `users/${id}/email`))
        ]);
        if (codeS.exists() || byS.exists() || emailS.exists()) {
            return { uid: id, data: { referralCode: codeS.val() || '', referredBy: byS.val() || '' } };
        }
    }

    const usersRef = ref(db, 'users');

    // 2) referralCode (पुराने short codes)
    const codeCandidates = [id];
    if (id.toUpperCase() !== id) codeCandidates.push(id.toUpperCase());
    for (const code of codeCandidates) {
        const snap = await get(query(usersRef, orderByChild('referralCode'), equalTo(code), limitToFirst(1)));
        if (snap.exists()) {
            const [uid, node] = Object.entries(snap.val())[0];
            return { uid, data: { referralCode: node.referralCode || '', referredBy: node.referredBy || '' } };
        }
    }

    // 3) username
    const unameSnap = await get(query(usersRef, orderByChild('username'), equalTo(id), limitToFirst(1)));
    if (unameSnap.exists()) {
        const [uid, node] = Object.entries(unameSnap.val())[0];
        return { uid, data: { referralCode: node.referralCode || '', referredBy: node.referredBy || '' } };
    }

    return null;
}

async function buildUplineChain(firstReferrer, newUid) {
    const chain = [firstReferrer];
    const visited = new Set([newUid, firstReferrer.uid]);
    let current = firstReferrer;

    while (chain.length < MAX_LEVELS) {
        const nextId = current.data && current.data.referredBy;
        if (!nextId) break;

        const next = await resolveUser(nextId);
        if (!next) {
            console.warn('⚠️ Upline not found, chain stops at level', chain.length, '| id:', nextId);
            break;
        }
        if (visited.has(next.uid)) {
            console.warn('⚠️ Loop detected in referral chain, stopping');
            break;
        }
        visited.add(next.uid);
        chain.push(next);
        current = next;
    }
    return chain;
}

// ============================================================
// REGISTRATION SUBMIT
// ============================================================
let isSubmitting = false;

document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    const name = sanitizeName(document.getElementById('regName').value);
    const email = document.getElementById('regEmail').value.trim().toLowerCase();
    const pass = document.getElementById('regPassword').value;
    const typedRef = extractRefCode(document.getElementById('regRef').value);
    const registerBtn = document.getElementById('registerBtn');

    if (!name || name.length < 2) { showToast('❌ Please enter your full name', 'error'); return; }
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) { showToast('❌ Please enter a valid email address', 'error'); return; }
    if (pass.length < 6) { showToast('❌ Password must be at least 6 characters long!', 'error'); return; }

    isSubmitting = true;
    registerBtn.disabled = true;
    registerBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Creating Account...';

    let createdUser = null;

    try {
        // 1. Firebase Auth में account
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        createdUser = cred.user;
        const uid = cred.user.uid;

        try {
            await updateProfile(cred.user, { displayName: name });
        } catch (profileErr) {
            console.warn('updateProfile failed (non-fatal):', profileErr);
        }

        // 2. Referrer और upline चेन
        const finalRefCode = typedRef || referralCodeFromURL || '';
        let chain = [];
        let referredByValue = '';

        if (finalRefCode) {
            const referrer = await resolveUser(finalRefCode);
            if (!referrer) {
                throw appError('app/invalid-referral',
                    '❌ Referral code not found. Please check it or leave it empty.');
            }
            if (referrer.uid === uid) {
                throw appError('app/invalid-referral', '❌ You cannot refer yourself.');
            }
            chain = await buildUplineChain(referrer, uid);
            referredByValue = referrer.data.referralCode || referrer.uid;
        }

        // 3. नया यूज़र (structure पहले जैसा)
        const userData = {
            uid: uid,
            username: uid,
            name: name,
            email: email,
            referralCode: uid,
            referredBy: referredByValue,
            rank: 'Member',
            role: 'user',
            banned: false,
            createdAt: Date.now(),
            lastActive: Date.now(),
            depositWallet: 0,
            referralWallet: 0,
            rndWallet: 0,
            lockedRND: 0,
            releaseWallet: 0,
            totalStake: 0,
            totalReward: 0,
            availableReward: 0,
            totalWithdrawn: 0,
            level1Earnings: 0,
            level2Earnings: 0,
            level3Earnings: 0,
            level4Earnings: 0,
            level5Earnings: 0,
            referralEarnings: 0,
            teamBusiness: 0,
            subscriptions: 0,
            totalReferrals: 0,
            downline: 0,
            teamStructure: { level1: 0, level2: 0, level3: 0, level4: 0, level5: 0 },
            directReferrals: {},
            packages: {},
            transferHistory: []
        };

        // 4. एक ही atomic update
        const updates = {};
        updates[`users/${uid}`] = userData;
        updates[`usernames/${uid}`] = uid;

        const joinedAt = Date.now();
        chain.forEach((node, index) => {
            const level = index + 1;
            const base = `users/${node.uid}`;

            updates[`${base}/totalReferrals`] = increment(1);
            updates[`${base}/downline`] = increment(1);
            updates[`${base}/teamStructure/level${level}`] = increment(1);

            if (level === 1) {
                updates[`${base}/directReferrals/${uid}`] = {
                    uid: uid,
                    name: name,
                    email: email,
                    joinedAt: joinedAt,
                    level: 1
                };
            }
        });

        await update(ref(db), updates);
        console.log(`✅ Registered. Upline levels updated: ${chain.length}`);

        showToast('✅ Account created successfully! Welcome ' + name + '!', 'success');

        setTimeout(() => {
            window.location.href = 'dashboard.html';
        }, 1500);

    } catch (err) {
        console.error('❌ Registration Error:', err);

        let rollbackFailed = false;
        if (createdUser) {
            try {
                await deleteUser(createdUser);
            } catch (delErr) {
                rollbackFailed = true;
                console.error('Rollback (delete auth user) failed:', delErr);
            }
        }

        let msg = 'Registration failed. Please try again.';
        if (err.code === 'auth/email-already-in-use') {
            msg = '❌ This email is already registered. Please login instead.';
        } else if (err.code === 'auth/weak-password') {
            msg = '❌ Password must be at least 6 characters.';
        } else if (err.code === 'auth/invalid-email') {
            msg = '❌ Please enter a valid email address.';
        } else if (err.code === 'auth/network-request-failed') {
            msg = '❌ Network problem. Please check your internet and try again.';
        } else if (err.code === 'app/invalid-referral') {
            msg = err.message;
        } else if (rollbackFailed) {
            msg = '❌ Account setup could not be completed. Please try logging in, or contact support.';
        }

        showToast(msg, 'error');
        isSubmitting = false;
        registerBtn.disabled = false;
        registerBtn.innerHTML = 'Create Account <i class="bi bi-arrow-right ms-2"></i>';
    }
});

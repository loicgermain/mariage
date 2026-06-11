// ── Config Firebase ──────────────────────────────────────────────────────────
// Remplacez ces valeurs après avoir créé votre projet Firebase pour activer la
// synchronisation entre appareils. Tant qu'elles ne sont pas remplies, l'app
// fonctionne en local (localStorage) sur cet appareil uniquement.
const firebaseConfig = {
  apiKey: "AIzaSyCkJDcatF7zsZKTDicTYpg6bdeU9yrK43o",
  authDomain: "mariage-loic-caro.firebaseapp.com",
  databaseURL: "https://mariage-loic-caro-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "mariage-loic-caro",
  storageBucket: "mariage-loic-caro.firebasestorage.app",
  messagingSenderId: "255168846859",
  appId: "1:255168846859:web:4316db18526a81da17fb0e",
  measurementId: "G-5LJ4QG1PVB"
};

export const isConfigured = !Object.values(firebaseConfig).some(v => String(v).includes('VOTRE_'));
const LS_KEY = 'mariage-data';

let fb = null;

async function initFirebase() {
  if (fb || !isConfigured) return fb;
  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
  const { getDatabase, ref, set, onValue, get } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js");
  const { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
  const app = initializeApp(firebaseConfig);
  const db = getDatabase(app);
  const auth = getAuth(app);
  fb = { db, ref, set, onValue, get, auth, signInWithEmailAndPassword, signOut, onAuthStateChanged };
  return fb;
}

// ── Authentification ─────────────────────────────────────────────────────────
export async function onAuthChange(callback) {
  if (!isConfigured) { callback({ local: true }); return; }
  const f = await initFirebase();
  f.onAuthStateChanged(f.auth, user => callback(user));
}

export async function signIn(email, password) {
  const f = await initFirebase();
  await f.signInWithEmailAndPassword(f.auth, email, password);
}

export async function doSignOut() {
  if (!isConfigured) return;
  const f = await initFirebase();
  await f.signOut(f.auth);
}

// ── Données (Firebase si configuré, sinon localStorage) ──────────────────────
export async function saveData(data) {
  if (isConfigured) {
    const f = await initFirebase();
    await f.set(f.ref(f.db, 'mariage'), data);
  } else {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  }
}

export async function listenData(callback) {
  if (isConfigured) {
    const f = await initFirebase();
    f.onValue(f.ref(f.db, 'mariage'), snap => { if (snap.exists()) callback(snap.val()); });
  } else {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) { try { callback(JSON.parse(raw)); } catch {} }
    // Synchronise entre onglets du même appareil
    window.addEventListener('storage', e => {
      if (e.key === LS_KEY && e.newValue) { try { callback(JSON.parse(e.newValue)); } catch {} }
    });
  }
}

export async function loadOnce() {
  if (isConfigured) {
    const f = await initFirebase();
    const snap = await f.get(f.ref(f.db, 'mariage'));
    return snap.exists() ? snap.val() : null;
  }
  const raw = localStorage.getItem(LS_KEY);
  return raw ? JSON.parse(raw) : null;
}

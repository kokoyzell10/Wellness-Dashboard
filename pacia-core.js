import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://qtvyhdjhgroeswtsfldi.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF0dnloZGpoZ3JvZXN3dHNmbGRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk0NDM5MDMsImV4cCI6MjA4NTAxOTkwM30.Z5mf1xMNoNRdJtRBFIbDSgl8J0qk-0J3c3ywGW2WwlE";

const STORAGE_MAP = Object.freeze({
  meals: "paciaMeals",
  workoutDays: "paciaWorkoutDays",
  waterLogs: "paciaWaterLogs",
  caffeineLogs: "paciaCaffeineLogs",
  recipes: "paciaRecipes",
  workoutSessions: "paciaWorkoutSessions",
  exerciseLibrary: "paciaExerciseLibrary",
  journalPages: "paciaJournalPages",
  sleepLogs: "paciaSleepLogs",
  foodDB: "paciaFoodDB",
  barcodeDB: "paciaBarcodeDB"
});

const STORAGE_DEFAULTS = Object.freeze({
  meals: [],
  workoutDays: [],
  waterLogs: [],
  caffeineLogs: [],
  recipes: [],
  workoutSessions: {},
  exerciseLibrary: [],
  journalPages: [],
  sleepLogs: [],
  foodDB: {},
  barcodeDB: {}
});

const ALLOWED_EMAILS = [];

const TRACKED_KEYS = new Set(Object.values(STORAGE_MAP));
const LAST_USER_KEY = "paciaLastUserId";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let cloudCache = null;
let activeUser = null;
let syncTimer = null;
let saving = false;
let applyingCloudToLocal = false;
let syncEnabled = false;

const PAGE_STATE = {
  signInButton: null,
  signOutButton: null,
  signInLabel: null,
  signedInClass: "",
  signedOutText: "Sign in",
  signOutText: "Logout",
  toast: null,
  onCloudApplied: null,
  onAuthChanged: null,
  allowedEmails: [],
  enforceAllowlist: false
};

function safeParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolveElement(target) {
  if (!target) return null;
  if (typeof target === "string") return document.querySelector(target);
  return target;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function getDisplayName(user) {
  return (
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    user?.email ||
    "Signed in"
  );
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[c]
  ));
}

function emitCloudApplied(source = "cloud") {
  window.dispatchEvent(new CustomEvent("pacia:cloud-applied", { detail: { source } }));
  if (typeof PAGE_STATE.onCloudApplied === "function") {
    PAGE_STATE.onCloudApplied();
  }
}

function showToast(message) {
  if (!message) return;
  if (typeof PAGE_STATE.toast === "function") {
    PAGE_STATE.toast(message);
    return;
  }
  console.info("[Pacia]", message);
}

function setButtonLabel(button, text, labelEl = null) {
  if (!button) return;
  if (labelEl) {
    labelEl.textContent = text;
    return;
  }
  if (button.querySelector(".dot")) {
    button.innerHTML = `<span class="dot"></span> ${escapeHtml(text)}`;
    return;
  }
  button.textContent = text;
}

function renderSignedOut() {
  const { signInButton, signOutButton, signInLabel, signedInClass, signedOutText, signOutText } = PAGE_STATE;
  if (signInButton) {
    signInButton.disabled = false;
    signInButton.removeAttribute("aria-disabled");
    if (signedInClass) signInButton.classList.remove(signedInClass);
    setButtonLabel(signInButton, signedOutText, signInLabel);
  }
  if (signOutButton) {
    signOutButton.style.display = "none";
    signOutButton.disabled = false;
    setButtonLabel(signOutButton, signOutText);
  }
}

function renderSignedIn(user) {
  const { signInButton, signOutButton, signInLabel, signedInClass, signOutText } = PAGE_STATE;
  if (signInButton) {
    signInButton.disabled = true;
    signInButton.setAttribute("aria-disabled", "true");
    if (signedInClass) signInButton.classList.add(signedInClass);
    setButtonLabel(signInButton, getDisplayName(user), signInLabel);
  }
  if (signOutButton) {
    signOutButton.style.display = "";
    signOutButton.disabled = false;
    setButtonLabel(signOutButton, signOutText);
  }
}

function renderUnauthorized(user) {
  const { signInButton, signOutButton, signInLabel, signedInClass } = PAGE_STATE;
  if (signInButton) {
    signInButton.disabled = true;
    signInButton.setAttribute("aria-disabled", "true");
    if (signedInClass) signInButton.classList.add(signedInClass);
    setButtonLabel(signInButton, "Access denied", signInLabel);
    signInButton.title = `Account ${user?.email || ""} is not allowlisted`;
  }
  if (signOutButton) {
    signOutButton.style.display = "";
    signOutButton.disabled = false;
  }
}

function readAllLocalState() {
  const payload = {};
  for (const [cloudKey, lsKey] of Object.entries(STORAGE_MAP)) {
    const fallback = cloneValue(STORAGE_DEFAULTS[cloudKey]);
    const raw = localStorage.getItem(lsKey);
    payload[cloudKey] = raw == null ? fallback : safeParse(raw, fallback);
  }
  return payload;
}

function writeAllLocalState(sourceData = null, sourceName = "cloud") {
  const cloudData = sourceData || {};
  applyingCloudToLocal = true;
  try {
    for (const [cloudKey, lsKey] of Object.entries(STORAGE_MAP)) {
      const fallback = cloneValue(STORAGE_DEFAULTS[cloudKey]);
      const nextValue = cloudData[cloudKey] === undefined ? fallback : cloudData[cloudKey];
      localStorage.setItem(lsKey, JSON.stringify(nextValue));
    }
  } finally {
    applyingCloudToLocal = false;
  }
  emitCloudApplied(sourceName);
}

function queueCloudSave() {
  if (!syncEnabled || !activeUser?.id || applyingCloudToLocal) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    saveMerged(readAllLocalState()).catch((err) => {
      console.warn("Cloud sync failed:", err);
    });
  }, 700);
}

function hasAnyData(payload) {
  return Object.values(payload || {}).some((value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") return Object.keys(value).length > 0;
    return Boolean(value);
  });
}

function installStorageHooks() {
  if (window.__paciaStorageHooksInstalled) return;
  window.__paciaStorageHooksInstalled = true;

  const nativeSetItem = localStorage.setItem.bind(localStorage);
  const nativeRemoveItem = localStorage.removeItem.bind(localStorage);
  const nativeClear = localStorage.clear.bind(localStorage);

  localStorage.setItem = function patchedSetItem(key, value) {
    nativeSetItem(key, value);
    if (TRACKED_KEYS.has(String(key))) queueCloudSave();
  };

  localStorage.removeItem = function patchedRemoveItem(key) {
    nativeRemoveItem(key);
    if (TRACKED_KEYS.has(String(key))) queueCloudSave();
  };

  localStorage.clear = function patchedClear() {
    nativeClear();
    queueCloudSave();
  };
}

async function loadCloudData(userId) {
  const { data, error } = await supabase
    .from("wellness_state")
    .select("data")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data?.data || null;
}

async function saveMerged(partial) {
  if (!activeUser?.id) return;
  if (saving) return;

  saving = true;
  try {
    let base = cloudCache;
    if (!base) {
      base = await loadCloudData(activeUser.id);
    }

    const merged = { ...(base || {}), ...(partial || {}) };
    cloudCache = merged;

    await supabase
      .from("wellness_state")
      .upsert({
        user_id: activeUser.id,
        data: merged,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id" });
  } finally {
    saving = false;
  }
}

function allowlistSet(extraAllowedEmails = []) {
  const all = [...ALLOWED_EMAILS, ...extraAllowedEmails];
  return new Set(all.map(normalizeEmail).filter(Boolean));
}

function isUserAllowlisted(user) {
  const set = allowlistSet(PAGE_STATE.allowedEmails);
  if (!PAGE_STATE.enforceAllowlist || !set.size) return true;
  return set.has(normalizeEmail(user?.email));
}

async function handleOAuthRedirect() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  if (!code) return;

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  history.replaceState({}, document.title, url.toString());

  if (error) {
    showToast(`Sign-in failed: ${error.message}`);
  } else {
    showToast("Signed in");
  }
}

async function applyAuthState(sessionUser = null) {
  const user = sessionUser || (await supabase.auth.getUser()).data?.user || null;

  if (!user) {
    activeUser = null;
    cloudCache = null;
    syncEnabled = false;
    renderSignedOut();
    if (typeof PAGE_STATE.onAuthChanged === "function") PAGE_STATE.onAuthChanged({ user: null, authorized: false });
    return;
  }

  if (!isUserAllowlisted(user)) {
    activeUser = null;
    cloudCache = null;
    syncEnabled = false;
    writeAllLocalState(null, "reset");
    renderUnauthorized(user);
    if (typeof PAGE_STATE.onAuthChanged === "function") PAGE_STATE.onAuthChanged({ user, authorized: false });
    showToast("This Google account is not allowed for this app.");
    await supabase.auth.signOut();
    return;
  }

  activeUser = user;
  renderSignedIn(user);

  try {
    const cloudData = await loadCloudData(user.id);
    const lastUserId = localStorage.getItem(LAST_USER_KEY);
    const hasCloudData = Boolean(cloudData && Object.keys(cloudData).length);

    if (hasCloudData) {
      cloudCache = cloudData;
      writeAllLocalState(cloudData, "cloud");
    } else if (lastUserId && lastUserId === user.id) {
      const localState = readAllLocalState();
      if (hasAnyData(localState)) {
        cloudCache = localState;
        await saveMerged(localState);
        emitCloudApplied("local");
      } else {
        cloudCache = {};
        writeAllLocalState({}, "cloud");
      }
    } else {
      cloudCache = {};
      writeAllLocalState({}, "cloud");
    }

    localStorage.setItem(LAST_USER_KEY, user.id);
  } catch (err) {
    console.warn("Cloud load failed:", err);
    showToast("Cloud unavailable. Using local data.");
  }

  syncEnabled = true;
  if (typeof PAGE_STATE.onAuthChanged === "function") PAGE_STATE.onAuthChanged({ user, authorized: true });
}

function resolveOptionValue(value, fallback) {
  return value == null ? fallback : value;
}

export async function initPaciaApp(options = {}) {
  installStorageHooks();

  PAGE_STATE.signInButton = resolveElement(options.signInButton);
  PAGE_STATE.signOutButton = resolveElement(options.signOutButton);
  PAGE_STATE.signInLabel = resolveElement(options.signInLabel);
  PAGE_STATE.signedInClass = resolveOptionValue(options.signedInClass, "");
  PAGE_STATE.signedOutText = resolveOptionValue(options.signedOutText, "Sign in");
  PAGE_STATE.signOutText = resolveOptionValue(options.signOutText, "Logout");
  PAGE_STATE.toast = typeof options.toast === "function" ? options.toast : null;
  PAGE_STATE.onCloudApplied = typeof options.onCloudApplied === "function" ? options.onCloudApplied : null;
  PAGE_STATE.onAuthChanged = typeof options.onAuthChanged === "function" ? options.onAuthChanged : null;
  PAGE_STATE.allowedEmails = Array.isArray(options.allowedEmails) ? options.allowedEmails : [];
  PAGE_STATE.enforceAllowlist = resolveOptionValue(options.enforceAllowlist, false);

  window.saveToSupabase = function saveToSupabase(payload) {
    if (!activeUser?.id) throw new Error("Not signed in");
    return saveMerged(payload || {});
  };

  const signInBtn = PAGE_STATE.signInButton;
  const signOutBtn = PAGE_STATE.signOutButton;
  const backLinks = document.querySelectorAll("[data-back-link]");

  backLinks.forEach((link) => {
    if (link.dataset.paciaBackBound === "1") return;
    link.dataset.paciaBackBound = "1";
    link.addEventListener("click", (event) => {
      if (window.history.length > 1) {
        event.preventDefault();
        window.history.back();
      }
    });
  });

  signInBtn?.addEventListener("click", async () => {
    if (signInBtn.disabled) return;
    if (window.location.protocol === "file:") {
      showToast("Google sign-in works only on HTTPS (GitHub Pages), not file://");
      return;
    }

    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo }
    });

    if (error) showToast(`Sign-in error: ${error.message}`);
  });

  signOutBtn?.addEventListener("click", async () => {
    syncEnabled = false;
    activeUser = null;
    cloudCache = null;
    await supabase.auth.signOut();
    writeAllLocalState(null, "reset");
    renderSignedOut();
  });

  try {
    await handleOAuthRedirect();
  } catch (err) {
    console.warn("OAuth redirect handling failed:", err);
    showToast("Sign-in callback failed. Please try again.");
  }
  await applyAuthState();

  supabase.auth.onAuthStateChange((_event, session) => {
    applyAuthState(session?.user || null).catch((err) => {
      console.warn("Auth state update failed:", err);
    });
  });
}

// [cloud] The logged-in user, their business and role, for the hosted app
// (VITE_CLOUD=1). Set once by CloudGate before <App/> renders.
import { isMirrored } from '../utils/prefsMirror';

export const CLOUD = import.meta.env.VITE_CLOUD === '1';

let session = null;
export const getSession = () => session;
export const setSession = (s) => { session = s; };
export const isReadOnly = () => !!session?.readOnly;
export const canAdmin = () => !!(session?.user?.isSuperAdmin || session?.role === 'admin');

// Small JSON client for the auth/admin endpoints.
export async function cloudApi(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Error ${res.status}`);
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

// Menu items that belong to the desktop app only, plus "New Invoice" for
// read-only (support) users.
const DESKTOP_ONLY = new Set(['controlpanel', 'lock', 'offline']);
export const cloudMenuFilter = (m) => !CLOUD || (!DESKTOP_ONLY.has(m.id) && !(isReadOnly() && m.id === 'new'));

// ---- keeping one person's / business's browser settings apart ----------
// Settings live in this browser's storage (print settings with letterhead and
// signature, numbering, theme...). When a different user or business opens
// in this browser, they are cleared and that user+business's own copy is
// loaded from the server (prefsMirror restorePrefs).
const SCOPE_KEY = 'gsp_scope';
const ALSO_SCOPED = ['freegstbill_invoiceOptions', 'gst_menuBrand', 'gst_stockAlertSettings'];
const SESSION_KEYS = ['gst_currentView', 'gst_editingBill', 'gst_settingsTab'];

export function clearScopedStorage() {
  try {
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (isMirrored(k) || ALSO_SCOPED.includes(k))) drop.push(k);
    }
    drop.forEach((k) => localStorage.removeItem(k));
    SESSION_KEYS.forEach((k) => sessionStorage.removeItem(k));
  } catch { /* storage blocked */ }
}

// Returns true when the scope changed (storage was cleared).
export function enterScope(s) {
  const scope = `${s.user.id}:${s.business?.id || ''}`;
  let prev = null;
  try { prev = localStorage.getItem(SCOPE_KEY); } catch { /* blocked */ }
  if (prev === scope) return false;
  clearScopedStorage();
  try { localStorage.setItem(SCOPE_KEY, scope); } catch { /* blocked */ }
  return true;
}

export async function logout() {
  try { await cloudApi('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* already gone */ }
  clearScopedStorage();
  try { localStorage.removeItem(SCOPE_KEY); } catch { /* blocked */ }
  window.location.replace('/');
}

export async function switchBusiness(businessId) {
  await cloudApi('/api/auth/switch-business', { method: 'POST', body: { businessId } });
  // A full reload: every screen starts again with the new business's data.
  window.location.replace('/');
}

// [cloud] Everything before the app opens in the hosted version: log in,
// first-time password change, choosing a business, and loading that
// business's settings into this browser.
import { useEffect, useState } from 'react';
import { LogIn, KeyRound, Building2 } from 'lucide-react';
import { startMirroring, isMirrored } from '../utils/prefsMirror';
import { toast } from '../components/Toast';
import { cloudApi, setSession, enterScope, logout, switchBusiness } from './cloudSession';

// The business's shared settings from the server replace this browser's copy
// (several people use them; the server copy is the up-to-date one).
async function loadBusinessPrefs(readOnly) {
  try {
    const { value } = await cloudApi('/api/local-prefs');
    for (const [k, v] of Object.entries(value || {})) {
      if (isMirrored(k) && typeof v === 'string') localStorage.setItem(k, v);
    }
    // A read-only user never runs the set-up wizard (they could not save it).
    if (readOnly) {
      const ps = JSON.parse(localStorage.getItem('gst_printSettings') || '{}');
      if (!ps.onboardingComplete) localStorage.setItem('gst_printSettings', JSON.stringify({ ...ps, onboardingComplete: true }));
      localStorage.setItem('freegstbill_onboarded', '1');
    }
    return true;
  } catch {
    return false;
  }
}

function Screen({ icon, title, subtitle, children }) {
  const Icon = icon;
  return (
    <div className="app-lock-screen">
      <div className="glass-panel app-lock-card" style={{ maxWidth: 420, width: '100%' }}>
        <Icon size={32} aria-hidden="true" />
        <h1>{title}</h1>
        {subtitle && <p className="text-muted">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

function LoginScreen({ onDone }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await cloudApi('/api/auth/login', { method: 'POST', body: { email, password } });
      onDone();
    } catch (err) {
      setError(err.message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen icon={LogIn} title="Sign in" subtitle="GST Portal">
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '100%', textAlign: 'left' }}>
        <label className="form-label">Email
          <input className="form-input" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="form-label">Password
          <input className="form-input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <p className="app-lock-error" role="alert">{error}</p>
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="text-muted" style={{ fontSize: '0.8rem', margin: 0 }}>Forgot your password? Ask your business admin to set a new one.</p>
      </form>
    </Screen>
  );
}

export function ChangePasswordForm({ forced, onDone, onCancel }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (next !== repeat) { setError('The new passwords differ.'); return; }
    setBusy(true);
    setError('');
    try {
      await cloudApi('/api/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      toast('Password changed', 'success');
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '100%', textAlign: 'left' }}>
      {forced && <p className="text-muted" style={{ margin: 0 }}>Your account was set up with a temporary password. Choose your own to continue.</p>}
      <label className="form-label">{forced ? 'Temporary password' : 'Current password'}
        <input className="form-input" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label className="form-label">New password
        <input className="form-input" type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <label className="form-label">Repeat new password
        <input className="form-input" type="password" autoComplete="new-password" required minLength={10} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
      </label>
      <p className="text-muted" style={{ fontSize: '0.8rem', margin: 0 }}>At least 10 characters, with letters and a digit.</p>
      <p className="app-lock-error" role="alert">{error}</p>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button className="btn btn-primary" type="submit" disabled={busy} style={{ flex: 1 }}>{busy ? 'Saving…' : 'Change password'}</button>
        {onCancel && <button className="btn btn-secondary" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function ChooseBusiness({ me, onSuperAdmin }) {
  const list = me.businesses || [];
  return (
    <Screen icon={Building2} title="Choose a business" subtitle={`Signed in as ${me.user.email}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%' }}>
        {list.length === 0 && (
          <p className="text-muted">
            {me.user.isSuperAdmin ? 'No businesses yet. Create the first one.' : 'Your login is not part of any business yet. Ask your admin to add you.'}
          </p>
        )}
        {list.map((b) => (
          <button key={b.id} className="btn btn-secondary" type="button" onClick={() => switchBusiness(b.id)}>{b.name}</button>
        ))}
        {me.user.isSuperAdmin && <button className="btn btn-primary" type="button" onClick={onSuperAdmin}>Manage businesses</button>}
        <button className="btn btn-secondary" type="button" onClick={logout}>Sign out</button>
      </div>
    </Screen>
  );
}

export default function CloudGate({ children, SuperAdminPanel }) {
  const [state, setState] = useState({ phase: 'loading' });

  const load = async () => {
    try {
      const me = await cloudApi('/api/auth/me');
      setSession(me);
      if (me.user.mustChangePassword) return setState({ phase: 'password', me });
      if (!me.business) return setState({ phase: 'choose', me });
      enterScope(me);
      const restored = await loadBusinessPrefs(me.readOnly);
      startMirroring(restored);
      setState({ phase: 'ready', me });
    } catch (err) {
      if (err.status === 401) setState({ phase: 'login' });
      else setState({ phase: 'error', message: err.message });
    }
  };

  useEffect(() => {
    load();
    // A session that ends while the app is open (logged out elsewhere,
    // expired) shows the sign-in screen; read-only refusals get a note.
    const onUnauth = () => setState((s) => (s.phase === 'ready' ? { phase: 'login' } : s));
    let lastNote = 0;
    const onReadOnly = () => {
      if (Date.now() - lastNote < 4000) return;
      lastNote = Date.now();
      toast('Read-only access: your changes were not saved.', 'error');
    };
    window.addEventListener('gsp-unauthenticated', onUnauth);
    window.addEventListener('gsp-read-only', onReadOnly);
    return () => {
      window.removeEventListener('gsp-unauthenticated', onUnauth);
      window.removeEventListener('gsp-read-only', onReadOnly);
    };
  }, []);

  if (state.phase === 'loading') return <div className="app-lock-screen"><p className="text-muted">Loading…</p></div>;
  if (state.phase === 'error') {
    return (
      <Screen icon={LogIn} title="Cannot reach the server" subtitle={state.message}>
        <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>Try again</button>
      </Screen>
    );
  }
  if (state.phase === 'login') return <LoginScreen onDone={() => window.location.replace('/')} />;
  if (state.phase === 'password') {
    return (
      <Screen icon={KeyRound} title="Choose your password" subtitle={state.me.user.email}>
        <ChangePasswordForm forced onDone={() => window.location.replace('/')} />
        <button className="app-lock-link" type="button" onClick={logout}>Sign out</button>
      </Screen>
    );
  }
  if (state.phase === 'choose') {
    if (state.showAdmin && SuperAdminPanel) return <SuperAdminPanel onClose={() => setState({ ...state, showAdmin: false })} standalone />;
    return <ChooseBusiness me={state.me} onSuperAdmin={() => setState({ ...state, showAdmin: true })} />;
  }
  return children;
}

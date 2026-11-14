// [cloud] Admin screens of the hosted app, shown as full-screen panels:
//  - UsersPanel: a business admin manages admin / support users of their
//    business; the super admin can pick any business.
//  - SuperAdminPanel: businesses (create, rename, disable), with an overview.
import { useEffect, useState, useCallback } from 'react';
import { X, UserPlus, Building2, RefreshCw } from 'lucide-react';
import { cloudApi, getSession, switchBusiness } from './cloudSession';

const panelStyle = { position: 'fixed', inset: 0, zIndex: 10000, overflow: 'auto', background: 'var(--bg, #f8fafc)', padding: '1.5rem' };
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' };
const th = { textAlign: 'left', padding: '0.5rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontWeight: 600 };
const td = { padding: '0.5rem', borderBottom: '1px solid var(--border)', verticalAlign: 'middle' };
const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '-');
const inr = (n) => Number(n || 0).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

function Header({ title, onClose, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
      <h1 style={{ margin: 0, fontSize: '1.4rem', flex: 1 }}>{title}</h1>
      {children}
      <button className="btn btn-secondary" type="button" onClick={onClose} aria-label="Close"><X size={16} /> Close</button>
    </div>
  );
}

function ErrorNote({ text }) {
  return text ? <p role="alert" style={{ color: 'var(--danger, #dc2626)', margin: '0.5rem 0' }}>{text}</p> : null;
}

// ---------------------------------------------------------------------------
export function UsersPanel({ onClose }) {
  const me = getSession();
  const isSuper = me.user.isSuperAdmin;
  const [businessId, setBusinessId] = useState(me.business?.id || '');
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'support' });
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setError('');
    try {
      const qs = isSuper && businessId ? `?businessId=${encodeURIComponent(businessId)}` : '';
      setUsers(await cloudApi(`/api/admin/users${qs}`));
    } catch (err) { setError(err.message); }
  }, [isSuper, businessId]);
  useEffect(() => { reload(); }, [reload]);

  const act = async (fn) => {
    setBusy(true);
    setError('');
    try { await fn(); await reload(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const body = (extra) => ({ ...(isSuper ? { businessId } : {}), ...extra });
  const roleIn = (u) => u.memberships.find((m) => m.businessId === businessId)?.role;

  const add = (e) => {
    e.preventDefault();
    act(async () => {
      const r = await cloudApi('/api/admin/users', { method: 'POST', body: body(form) });
      setForm({ email: '', name: '', password: '', role: 'support' });
      if (r.existing) setError(''); // existing login added to this business
    });
  };
  const resetPassword = (u) => {
    const pw = window.prompt(`New temporary password for ${u.email} (10+ characters, letters and a digit). They will be asked to change it.`);
    if (pw) act(() => cloudApi(`/api/admin/users/${u.id}/reset-password`, { method: 'POST', body: { password: pw } }));
  };

  return (
    <div style={panelStyle} role="dialog" aria-label="Users">
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
        <Header title="Users" onClose={onClose}>
          {isSuper && (
            <select className="form-input" style={{ width: 'auto' }} value={businessId} onChange={(e) => setBusinessId(e.target.value)} aria-label="Business">
              {me.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
        </Header>
        <p className="text-muted" style={{ marginTop: 0 }}>
          <strong>Admin</strong>: everything in the business, including users. <strong>Support</strong>: can view and print, cannot change anything.
        </p>
        <ErrorNote text={error} />

        <div className="glass-panel" style={{ padding: '1rem', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1rem', marginTop: 0 }}><UserPlus size={16} /> Add a user</h2>
          <form onSubmit={add} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.5rem', alignItems: 'end' }}>
            <label className="form-label">Email<input className="form-input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label className="form-label">Name<input className="form-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="form-label">Temporary password<input className="form-input" type="text" autoComplete="off" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="not needed for an existing login" /></label>
            <label className="form-label">Role
              <select className="form-input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="support">Support (read-only)</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <button className="btn btn-primary" type="submit" disabled={busy}>Add</button>
          </form>
          <p className="text-muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>Give the person their temporary password yourself; they choose their own at first sign-in.</p>
        </div>

        <table style={tableStyle}>
          <thead><tr><th style={th}>User</th><th style={th}>Role</th><th style={th}>Last sign-in</th><th style={th}>Status</th><th style={th}></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td style={td}><div>{u.name || '-'}</div><div className="text-muted" style={{ fontSize: '0.8rem' }}>{u.email}{u.isSuperAdmin ? ' (super admin)' : ''}</div></td>
                <td style={td}>
                  <select className="form-input" style={{ width: 'auto' }} value={roleIn(u) || ''} disabled={busy || u.id === me.user.id}
                    onChange={(e) => act(() => cloudApi(`/api/admin/users/${u.id}/membership`, { method: 'PUT', body: body({ role: e.target.value }) }))}>
                    <option value="admin">Admin</option>
                    <option value="support">Support</option>
                  </select>
                </td>
                <td style={td}>{fmtDate(u.lastLoginAt)}</td>
                <td style={td}>{u.status}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  {u.id !== me.user.id && (
                    <>
                      <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => resetPassword(u)}>Reset password</button>{' '}
                      <button className="btn btn-secondary" type="button" disabled={busy}
                        onClick={() => window.confirm(`Remove ${u.email} from this business?`) && act(() => cloudApi(`/api/admin/users/${u.id}/membership${isSuper ? `?businessId=${encodeURIComponent(businessId)}` : ''}`, { method: 'DELETE' }))}>
                        Remove
                      </button>
                      {isSuper && (
                        <>{' '}
                          <button className="btn btn-secondary" type="button" disabled={busy}
                            onClick={() => act(() => cloudApi(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { status: u.status === 'active' ? 'disabled' : 'active' } }))}>
                            {u.status === 'active' ? 'Disable login' : 'Enable login'}
                          </button>
                        </>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
            {users.length === 0 && <tr><td style={td} colSpan={5} className="text-muted">No users yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function SuperAdminPanel({ onClose }) {
  const [rows, setRows] = useState([]);
  const [overview, setOverview] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', gstin: '', adminEmail: '', adminName: '', adminPassword: '' });

  const reload = useCallback(async () => {
    setError('');
    try {
      const [list, ov] = await Promise.all([cloudApi('/api/admin/businesses'), cloudApi('/api/admin/overview')]);
      setRows(list);
      setOverview(Object.fromEntries(ov.map((o) => [o.id, o])));
    } catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const act = async (fn) => {
    setBusy(true);
    setError('');
    try { await fn(); await reload(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const create = (e) => {
    e.preventDefault();
    act(async () => {
      await cloudApi('/api/admin/businesses', {
        method: 'POST',
        body: {
          name: form.name, gstin: form.gstin,
          admin: form.adminEmail ? { email: form.adminEmail, name: form.adminName, password: form.adminPassword } : undefined,
        },
      });
      setForm({ name: '', gstin: '', adminEmail: '', adminName: '', adminPassword: '' });
    });
  };
  const rename = (b) => {
    const name = window.prompt('Business name', b.name);
    if (name && name.trim() && name !== b.name) act(() => cloudApi(`/api/admin/businesses/${b.id}`, { method: 'PATCH', body: { name } }));
  };

  return (
    <div style={panelStyle} role="dialog" aria-label="Businesses">
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <Header title="Businesses" onClose={onClose}>
          <button className="btn btn-secondary" type="button" onClick={reload} disabled={busy}><RefreshCw size={16} /> Refresh</button>
        </Header>
        <ErrorNote text={error} />

        <div className="glass-panel" style={{ padding: '1rem', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1rem', marginTop: 0 }}><Building2 size={16} /> New business</h2>
          <form onSubmit={create} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.5rem', alignItems: 'end' }}>
            <label className="form-label">Business name<input className="form-input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="form-label">GSTIN (optional)<input className="form-input" maxLength={15} value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} /></label>
            <label className="form-label">First admin's email<input className="form-input" type="email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} placeholder="optional" /></label>
            <label className="form-label">Admin's name<input className="form-input" value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} /></label>
            <label className="form-label">Temporary password<input className="form-input" type="text" autoComplete="off" value={form.adminPassword} onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} placeholder="for a new login" /></label>
            <button className="btn btn-primary" type="submit" disabled={busy}>Create</button>
          </form>
        </div>

        <table style={tableStyle}>
          <thead><tr>
            <th style={th}>Business</th><th style={th}>Users</th><th style={th}>Quotations</th><th style={th}>Invoices</th>
            <th style={th}>Invoiced</th><th style={th}>Last activity</th><th style={th}>Status</th><th style={th}></th>
          </tr></thead>
          <tbody>
            {rows.map((b) => {
              const o = overview[b.id] || {};
              return (
                <tr key={b.id} style={{ opacity: b.status === 'active' ? 1 : 0.55 }}>
                  <td style={td}><div>{b.name}</div><div className="text-muted" style={{ fontSize: '0.8rem' }}>{b.gstin || 'no GSTIN'}</div></td>
                  <td style={td}>{b.users}</td>
                  <td style={td}>{o.quotations ?? 0}</td>
                  <td style={td}>{o.invoices ?? 0}</td>
                  <td style={td}>{inr(o.invoiced)}</td>
                  <td style={td}>{fmtDate(o.lastActivity)}</td>
                  <td style={td}>{b.status}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {b.status === 'active' && <button className="btn btn-primary" type="button" onClick={() => switchBusiness(b.id)}>Open</button>}{' '}
                    <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => rename(b)}>Rename</button>{' '}
                    <button className="btn btn-secondary" type="button" disabled={busy}
                      onClick={() => (b.status === 'active'
                        ? window.confirm(`Disable ${b.name}? Its users can no longer open it. Nothing is deleted.`)
                        : true) && act(() => cloudApi(`/api/admin/businesses/${b.id}`, { method: 'PATCH', body: { status: b.status === 'active' ? 'disabled' : 'active' } }))}>
                      {b.status === 'active' ? 'Disable' : 'Enable'}
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td style={td} colSpan={8} className="text-muted">No businesses yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

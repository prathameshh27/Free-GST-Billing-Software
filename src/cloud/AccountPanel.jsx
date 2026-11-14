// [cloud] Replaces the desktop "business profile" switcher at the top of the
// sidebar: the business you are in, switching business, your role, and the
// account menu (Users, Businesses, password, sign out).
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Building2, ChevronDown, Users, ShieldCheck, KeyRound, LogOut, Eye } from 'lucide-react';
import { getSession, canAdmin, logout, switchBusiness } from './cloudSession';
import { UsersPanel, SuperAdminPanel } from './AdminPanels';
import { ChangePasswordForm } from './CloudGate';

const ROLE_LABEL = { superadmin: 'Super admin', admin: 'Admin', support: 'Read-only' };

export default function AccountPanel() {
  const me = getSession();
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState(null); // 'users' | 'businesses' | 'password'
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!me) return null;
  const others = (me.businesses || []).filter((b) => b.id !== me.business?.id);
  const pick = (p) => { setOpen(false); setPanel(p); };

  return (
    <div className="profile-switcher" ref={ref} style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <div className="profile-switcher-row">
        <button className="profile-switcher-btn" type="button" onClick={() => setOpen((v) => !v)}
          title={`${me.business?.name} - ${me.user.email}`} aria-expanded={open}>
          <Building2 size={14} />
          <span className="profile-switcher-name">{me.business?.name}</span>
          <ChevronDown size={13} style={{ marginLeft: 'auto', opacity: 0.6 }} />
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.72rem', padding: '0.2rem 0.25rem 0', color: 'var(--text-muted)' }}>
        {me.readOnly ? <Eye size={12} /> : <ShieldCheck size={12} />}
        <span style={{
          fontWeight: 600,
          color: me.readOnly ? 'var(--warning-text, #b45309)' : 'inherit',
        }}>{ROLE_LABEL[me.role] || me.role}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {me.user.email}</span>
      </div>

      {open && (
        <div className="profile-switcher-menu">
          {others.length > 0 && <div className="text-muted" style={{ fontSize: '0.72rem', padding: '0.35rem 0.6rem' }}>Switch business</div>}
          {others.map((b) => (
            <button key={b.id} type="button" className="profile-switcher-item" onClick={() => switchBusiness(b.id)}>{b.name}</button>
          ))}
          {canAdmin() && (
            <button type="button" className="profile-switcher-item profile-switcher-manage" onClick={() => pick('users')}>
              <Users size={13} /> Users
            </button>
          )}
          {me.user.isSuperAdmin && (
            <button type="button" className="profile-switcher-item profile-switcher-manage" onClick={() => pick('businesses')}>
              <Building2 size={13} /> All businesses
            </button>
          )}
          <button type="button" className="profile-switcher-item profile-switcher-manage" onClick={() => pick('password')}>
            <KeyRound size={13} /> Change password
          </button>
          <button type="button" className="profile-switcher-item profile-switcher-manage" onClick={logout}>
            <LogOut size={13} /> Sign out
          </button>
        </div>
      )}

      {panel && createPortal(
        <>
          {panel === 'users' && <UsersPanel onClose={() => setPanel(null)} />}
          {panel === 'businesses' && <SuperAdminPanel onClose={() => setPanel(null)} />}
          {panel === 'password' && (
            <div className="modal-overlay" style={{ zIndex: 10000 }} onMouseDown={(e) => { if (e.target === e.currentTarget) setPanel(null); }}>
              <div className="modal-content glass-panel" style={{ maxWidth: 420, padding: '1.5rem' }}>
                <h2 style={{ marginTop: 0 }}>Change password</h2>
                <ChangePasswordForm onDone={() => setPanel(null)} onCancel={() => setPanel(null)} />
              </div>
            </div>
          )}
        </>,
        document.body,
      )}
    </div>
  );
}

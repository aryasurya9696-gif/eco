import React, { useState, useEffect } from 'react';
import { Plus, X, Eye, EyeOff, MoreHorizontal } from 'lucide-react';
import { mailStore, useMailStore } from './mail-store';
import { useEcho } from '../../context/EchoContext';
import type { Mailbox } from '../../types';

type AppPasswordProvider = 'google' | 'microsoft' | 'zoho' | 'custom';

const PROVIDER_LABEL: Record<Mailbox['provider'], string> = {
  resend: 'Echo hosted',
  ses: 'Echo hosted',
  brevo: 'Brevo',
  google: 'Google',
  microsoft: 'Microsoft',
  zoho: 'Zoho',
  custom: 'Custom SMTP',
};

const PROVIDER_STEPS: Record<AppPasswordProvider, string[]> = {
  google: [
    'Turn on 2-Step Verification in your Google Account → Security.',
    'Open “App passwords”, create one named “Echo”.',
    'Paste the 16-character password below.',
  ],
  microsoft: [
    'Turn on two-step verification in your Microsoft account → Security.',
    'Under “App passwords”, create a new one.',
    'Paste the generated password below.',
  ],
  zoho: [
    'In Zoho Mail, go to My Account → Security → App Passwords.',
    'Generate a password named “Echo”.',
    'Paste it below.',
  ],
  custom: ['Use the SMTP password your mail provider gave you. Echo connects over SSL on port 465.'],
};

const STATUS_STYLE: Record<Mailbox['status'], { label: string; dot: string; text: string }> = {
  active: { label: 'Active', dot: 'bg-emerald-500', text: 'text-emerald-700' },
  paused: { label: 'Paused', dot: 'bg-amber-500', text: 'text-amber-700' },
  needs_reauth: { label: 'Needs reconnect', dot: 'bg-red-500', text: 'text-red-600' },
  disabled: { label: 'Disabled', dot: 'bg-[#a1a1aa]', text: 'text-[#71717a]' },
};

const inputClass =
  'w-full h-9 px-3 text-[13px] text-[#18181b] bg-white border border-[#e8e8e3] rounded-md placeholder:text-[#c4c4bf] focus:outline-none focus:border-[#a1a1aa]';

export const AccountsPanel: React.FC = () => {
  const { mailboxes, activeMailboxId } = useMailStore();
  const { addToast } = useEcho();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [provider, setProvider] = useState<AppPasswordProvider>('google');
  const [emailAddress, setEmailAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [smtpHost, setSmtpHost] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const closeModal = () => {
    setIsModalOpen(false);
    setEmailAddress('');
    setDisplayName('');
    setAppPassword('');
    setSmtpHost('');
    setShowPassword(false);
    setFormError(null);
  };

  useEffect(() => {
    if (!isModalOpen && !menuFor) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isModalOpen) closeModal();
      setMenuFor(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isModalOpen, menuFor]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isConnecting) return;
    const email = emailAddress.trim();
    const password = appPassword.replace(/\s+/g, '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setFormError('Enter a valid email address.');
    if (!displayName.trim()) return setFormError('Enter the name recipients should see.');
    if (provider === 'google' && password.length !== 16) {
      return setFormError('Google app passwords are 16 characters long.');
    }
    if (password.length < 8) return setFormError('That password looks too short.');
    if (provider === 'custom' && !smtpHost.trim()) return setFormError('Enter your SMTP server.');

    // The server signs in with the password before saving it, which can take a few seconds.
    setIsConnecting(true);
    const res = await mailStore.connectAppPasswordMailbox(email, displayName, provider, password, smtpHost.trim());
    setIsConnecting(false);
    if ('error' in res) return setFormError(res.error);

    closeModal();
    addToast(`${res.mailbox.address} connected.`, 'success');
  };

  const handleRemove = async (mb: Mailbox) => {
    setMenuFor(null);
    if (!window.confirm(`Disconnect ${mb.address}? Its conversations and saved password will be deleted from Echo.`)) return;
    if (await mailStore.removeMailbox(mb.id)) {
      addToast(`${mb.address} disconnected.`, 'info');
    } else {
      addToast(`Could not disconnect ${mb.address}. Please try again.`, 'error');
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-white">
      <div className="max-w-4xl mx-auto px-4 sm:px-8 py-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h2 className="text-[19px] font-semibold text-[#18181b]">Mailboxes</h2>
            <p className="mt-1 text-[13px] text-[#71717a] max-w-xl">
              The addresses you send outreach from. Connect Gmail or Zoho with an app password, or create an address on a verified domain in Domains.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setIsModalOpen(true)}
            className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 bg-[#18181b] hover:bg-black text-white text-[13px] font-medium rounded-lg transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Connect mailbox
          </button>
        </div>

        {mailboxes.length === 0 && (
          <div className="rounded-xl border border-dashed border-[#e8e8e3] px-6 py-12 text-center">
            <div className="text-[14px] font-medium text-[#18181b]">No mailboxes yet</div>
            <p className="mt-1 text-[13px] text-[#71717a]">Connect a mailbox to start sending outreach.</p>
          </div>
        )}

        {mailboxes.length > 0 && (
        <ul className="rounded-xl border border-[#e8e8e3] divide-y divide-[#f0f0eb]">
          {mailboxes.map((mb) => {
            const isActive = mb.id === activeMailboxId;
            const status = STATUS_STYLE[mb.status];
            const usage = Math.min(100, (mb.sent_today / Math.max(1, mb.daily_send_limit)) * 100);
            return (
              <li key={mb.id} className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-4">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className="w-9 h-9 shrink-0 rounded-full bg-[#f0f0eb] text-[#52525b] flex items-center justify-center text-[13px] font-semibold">
                    {(mb.display_name || mb.address)[0]?.toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[14px] font-medium text-[#18181b] truncate">{mb.display_name}</span>
                      {mb.is_default && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#f4f4f0] text-[#52525b]">Default</span>
                      )}
                      {isActive && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800">Viewing</span>
                      )}
                    </div>
                    <div className="text-[13px] text-[#71717a] truncate">{mb.address}</div>
                    <div className="mt-1 flex items-center gap-3 text-[12px]">
                      <span className={`inline-flex items-center gap-1.5 ${status.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
                        {status.label}
                      </span>
                      <span className="text-[#a1a1aa]">{PROVIDER_LABEL[mb.provider]}</span>
                    </div>
                  </div>
                </div>

                <div className="sm:w-44 shrink-0">
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="text-[#71717a]">Sent today</span>
                    <span className="text-[#18181b] tabular-nums">
                      {mb.sent_today} / {mb.daily_send_limit}
                    </span>
                  </div>
                  <div className="mt-1.5 w-full bg-[#f0f0eb] h-1.5 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        usage >= 100 ? 'bg-red-500' : usage >= 85 ? 'bg-amber-500' : 'bg-emerald-600'
                      }`}
                      style={{ width: `${usage}%` }}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-1 sm:justify-end relative">
                  {!isActive && (
                    <button
                      type="button"
                      onClick={() => {
                        mailStore.setActiveMailbox(mb.id);
                        mailStore.setActiveSubView('mailbox');
                      }}
                      className="h-8 px-3 text-[13px] text-[#18181b] border border-[#e8e8e3] rounded-md hover:bg-[#f4f4f0] transition-colors cursor-pointer"
                    >
                      Open inbox
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setMenuFor(menuFor === mb.id ? null : mb.id)}
                    className="p-2 rounded-md text-[#71717a] hover:text-[#18181b] hover:bg-[#f4f4f0] cursor-pointer"
                    aria-label={`More actions for ${mb.address}`}
                    aria-haspopup="menu"
                    aria-expanded={menuFor === mb.id}
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                  {menuFor === mb.id && (
                    <>
                      <div className="fixed inset-0 z-20" onClick={() => setMenuFor(null)} />
                      <div
                        role="menu"
                        className="absolute right-0 top-full mt-1 w-44 bg-white border border-[#e8e8e3] rounded-lg shadow-lg z-30 p-1"
                      >
                        {!mb.is_default && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              mailStore.setDefaultMailbox(mb.id);
                              setMenuFor(null);
                              addToast(`${mb.address} is now your default mailbox.`, 'success');
                            }}
                            className="w-full text-left px-2.5 py-1.5 rounded-md text-[13px] text-[#18181b] hover:bg-[#f4f4f0] cursor-pointer"
                          >
                            Make default
                          </button>
                        )}
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => handleRemove(mb)}
                          className="w-full text-left px-2.5 py-1.5 rounded-md text-[13px] text-red-600 hover:bg-red-50 cursor-pointer"
                        >
                          Disconnect
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        )}
      </div>

      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[2px] p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="connect-mailbox-title"
            className="w-full max-w-md bg-white rounded-2xl border border-[#e8e8e3] shadow-2xl"
          >
            <div className="flex items-center justify-between px-5 h-14 border-b border-[#f0f0eb]">
              <h3 id="connect-mailbox-title" className="text-[15px] font-semibold text-[#18181b]">
                Connect mailbox
              </h3>
              <button
                type="button"
                onClick={closeModal}
                className="p-2 rounded-md text-[#a1a1aa] hover:text-[#18181b] hover:bg-[#f4f4f0] cursor-pointer"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleConnect} className="p-5 space-y-4" noValidate>
              <div>
                <label htmlFor="mb-provider" className="block text-[12px] font-medium text-[#52525b] mb-1.5">
                  Provider
                </label>
                <select
                  id="mb-provider"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as AppPasswordProvider)}
                  className={`${inputClass} cursor-pointer`}
                >
                  <option value="google">Google Workspace / Gmail</option>
                  <option value="zoho">Zoho Mail</option>
                  <option value="custom">Other (SMTP / IMAP)</option>
                </select>
                <ol className="mt-2.5 space-y-1 text-[12px] text-[#71717a] list-decimal pl-4">
                  {PROVIDER_STEPS[provider].map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="mb-name" className="block text-[12px] font-medium text-[#52525b] mb-1.5">
                    Sender name
                  </label>
                  <input
                    id="mb-name"
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Alex Vance"
                    autoComplete="name"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="mb-email" className="block text-[12px] font-medium text-[#52525b] mb-1.5">
                    Email address
                  </label>
                  <input
                    id="mb-email"
                    type="email"
                    value={emailAddress}
                    onChange={(e) => setEmailAddress(e.target.value)}
                    placeholder="name@company.com"
                    autoComplete="email"
                    className={inputClass}
                  />
                </div>
              </div>

              {provider === 'custom' && (
                <div>
                  <label htmlFor="mb-smtp" className="block text-[12px] font-medium text-[#52525b] mb-1.5">
                    SMTP server
                  </label>
                  <input
                    id="mb-smtp"
                    type="text"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    placeholder="smtp.yourcompany.com"
                    autoComplete="off"
                    className={`${inputClass} font-mono`}
                  />
                </div>
              )}

              <div>
                <label htmlFor="mb-pass" className="block text-[12px] font-medium text-[#52525b] mb-1.5">
                  App password
                </label>
                <div className="relative">
                  <input
                    id="mb-pass"
                    type={showPassword ? 'text' : 'password'}
                    value={appPassword}
                    onChange={(e) => setAppPassword(e.target.value)}
                    placeholder={provider === 'google' ? 'xxxx xxxx xxxx xxxx' : ''}
                    autoComplete="off"
                    className={`${inputClass} pr-9 font-mono`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded text-[#a1a1aa] hover:text-[#18181b] cursor-pointer"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {formError && (
                <p role="alert" className="text-[12px] text-red-600">
                  {formError}
                </p>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={closeModal}
                  className="h-9 px-3.5 text-[13px] text-[#52525b] rounded-lg hover:bg-[#f4f4f0] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isConnecting}
                  className="h-9 px-4 bg-[#18181b] hover:bg-black text-white text-[13px] font-medium rounded-lg cursor-pointer disabled:opacity-50"
                >
                  {isConnecting ? 'Checking login…' : 'Connect'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

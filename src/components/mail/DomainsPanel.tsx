import React, { useState } from 'react';
import { Plus, Copy, Check, Trash2, Clock, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import { mailStore, useMailStore } from './mail-store';
import { useEcho } from '../../context/EchoContext';
import type { MailDomain, MailDnsRecord } from '../../types';

const DOMAIN_STATUS: Record<MailDomain['status'], { label: string; className: string; icon: React.ElementType }> = {
  verified: { label: 'Verified', className: 'bg-emerald-50 text-emerald-800', icon: CheckCircle2 },
  verifying: { label: 'Waiting for DNS', className: 'bg-amber-50 text-amber-800', icon: Clock },
  pending: { label: 'Waiting for DNS', className: 'bg-amber-50 text-amber-800', icon: Clock },
  failed: { label: 'Failed', className: 'bg-red-50 text-red-700', icon: AlertCircle },
  suspended: { label: 'Suspended', className: 'bg-red-50 text-red-700', icon: AlertCircle },
};

const RECORD_STATUS: Record<MailDnsRecord['status'], { label: string; className: string }> = {
  verified: { label: 'Found', className: 'text-emerald-700' },
  pending: { label: 'Pending', className: 'text-amber-700' },
  missing: { label: 'Missing', className: 'text-red-600' },
};

const CopyCell: React.FC<{ value: string; copied: boolean; onCopy: () => void }> = ({ value, copied, onCopy }) => (
  <button
    type="button"
    onClick={onCopy}
    title="Copy"
    className="group/copy w-full min-w-0 flex items-center gap-2 text-left font-mono text-[12px] text-[#3f3f46] hover:text-[#18181b] cursor-pointer"
  >
    <span className="truncate">{value}</span>
    {copied ? (
      <Check className="w-3.5 h-3.5 shrink-0 text-emerald-600" />
    ) : (
      <Copy className="w-3.5 h-3.5 shrink-0 text-[#c4c4bf] opacity-0 group-hover/copy:opacity-100" />
    )}
  </button>
);

/** Creates a sending address (alex@domain) on a verified domain. */
const HostedMailboxForm: React.FC<{ domain: MailDomain }> = ({ domain }) => {
  const { mailboxes } = useMailStore();
  const { addToast } = useEcho();
  const [localPart, setLocalPart] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const existing = mailboxes.filter((m) => m.domain_id === domain.id);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    if (!localPart.trim()) return setFormError('Enter the part before the @.');
    if (!displayName.trim()) return setFormError('Enter the name recipients should see.');
    setIsSaving(true);
    const res = await mailStore.createHostedMailbox(domain.id, localPart, displayName);
    setIsSaving(false);
    if ('error' in res) return setFormError(res.error);
    setLocalPart('');
    setDisplayName('');
    setFormError(null);
    addToast(`${res.mailbox.address} is ready to send.`, 'success');
  };

  const inputClass =
    'h-9 px-3 text-[13px] text-[#18181b] bg-white border border-[#e8e8e3] rounded-md placeholder:text-[#c4c4bf] focus:outline-none focus:border-[#a1a1aa]';

  return (
    <form onSubmit={handleSubmit} className="px-4 sm:px-5 py-4 border-t border-[#f0f0eb] bg-[#fafaf8]" noValidate>
      <div className="text-[13px] font-medium text-[#18181b]">Sending addresses</div>
      {existing.length > 0 && (
        <div className="mt-1 text-[12px] text-[#71717a] font-mono">{existing.map((m) => m.address).join(', ')}</div>
      )}
      <div className="mt-2 flex flex-col sm:flex-row gap-2">
        <div className="flex items-center flex-1 min-w-0">
          <input
            type="text"
            value={localPart}
            onChange={(e) => {
              setLocalPart(e.target.value);
              setFormError(null);
            }}
            placeholder="alex"
            aria-label="Address"
            className={`${inputClass} flex-1 min-w-0 font-mono rounded-r-none`}
          />
          <span className="h-9 px-2.5 flex items-center text-[12px] font-mono text-[#71717a] border border-l-0 border-[#e8e8e3] rounded-r-md bg-white truncate">
            @{domain.domain}
          </span>
        </div>
        <input
          type="text"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
            setFormError(null);
          }}
          placeholder="Sender name"
          aria-label="Sender name"
          className={`${inputClass} sm:w-44`}
        />
        <button
          type="submit"
          disabled={isSaving}
          className="h-9 px-4 bg-[#18181b] hover:bg-black text-white text-[13px] font-medium rounded-lg cursor-pointer disabled:opacity-50"
        >
          {isSaving ? 'Creating…' : 'Create address'}
        </button>
      </div>
      {formError && (
        <p role="alert" className="mt-2 text-[12px] text-red-600">
          {formError}
        </p>
      )}
    </form>
  );
};

export const DomainsPanel: React.FC = () => {
  const { domains } = useMailStore();
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { addToast } = useEcho();
  const [newDomainName, setNewDomainName] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = async (key: string, val: string) => {
    try {
      await navigator.clipboard.writeText(val);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    } catch {
      addToast('Could not copy. Select the text and copy it manually.', 'error');
    }
  };

  const handleAddDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    const res = await mailStore.addDomain(newDomainName);
    setIsSubmitting(false);
    if ('error' in res) {
      setFormError(res.error);
      return;
    }
    setNewDomainName('');
    setFormError(null);
    setIsAdding(false);
    addToast(`${res.domain.domain} added. Add the DNS records below at your registrar.`, 'success');
  };

  const handleRemove = async (dom: MailDomain) => {
    if (!window.confirm(`Remove ${dom.domain}? Mailboxes on this domain will stop sending.`)) return;
    const res = await mailStore.removeDomain(dom.id);
    if ('error' in res) addToast(res.error, 'error');
    else addToast(`${dom.domain} removed.`, 'info');
  };

  const handleCheck = async (dom: MailDomain) => {
    if (checkingId) return;
    setCheckingId(dom.id);
    const res = await mailStore.verifyDomain(dom.id);
    setCheckingId(null);
    if ('error' in res) addToast(res.error, 'error');
    else if (res.domain.status === 'verified') addToast(`${dom.domain} is verified. Create a sending address below.`, 'success');
    else addToast('Not verified yet. DNS changes can take a while to appear; try again later.', 'info');
  };

  return (
    <div className="flex-1 overflow-y-auto bg-white">
      <div className="max-w-4xl mx-auto px-4 sm:px-8 py-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h2 className="text-[19px] font-semibold text-[#18181b]">Domains & DNS</h2>
            <p className="mt-1 text-[13px] text-[#71717a] max-w-xl">
              Send from your own domain with DKIM, SPF and DMARC set up. Use a separate outreach domain (like
              trycompany.com) to protect your main domain’s reputation.
            </p>
          </div>
          {!isAdding && (
            <button
              type="button"
              onClick={() => setIsAdding(true)}
              className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 bg-[#18181b] hover:bg-black text-white text-[13px] font-medium rounded-lg transition-colors cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Add domain
            </button>
          )}
        </div>

        {isAdding && (
          <form onSubmit={handleAddDomain} className="rounded-xl border border-[#e8e8e3] bg-[#fafaf8] p-4" noValidate>
            <label htmlFor="new-domain" className="block text-[13px] font-medium text-[#18181b]">
              Domain
            </label>
            <div className="mt-2 flex flex-col sm:flex-row gap-2">
              <input
                id="new-domain"
                type="text"
                value={newDomainName}
                onChange={(e) => {
                  setNewDomainName(e.target.value);
                  setFormError(null);
                }}
                placeholder="trycompany.com"
                autoFocus
                className="flex-1 h-9 px-3 text-[13px] font-mono text-[#18181b] bg-white border border-[#e8e8e3] rounded-md placeholder:text-[#c4c4bf] focus:outline-none focus:border-[#a1a1aa]"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsAdding(false);
                    setNewDomainName('');
                    setFormError(null);
                  }}
                  className="h-9 px-3.5 text-[13px] text-[#52525b] rounded-lg hover:bg-[#f0f0eb] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="h-9 px-4 bg-[#18181b] hover:bg-black text-white text-[13px] font-medium rounded-lg cursor-pointer disabled:opacity-50"
                >
                  {isSubmitting ? 'Adding…' : 'Add domain'}
                </button>
              </div>
            </div>
            {formError && (
              <p role="alert" className="mt-2 text-[12px] text-red-600">
                {formError}
              </p>
            )}
          </form>
        )}

        {domains.length === 0 && !isAdding && (
          <div className="rounded-xl border border-dashed border-[#e8e8e3] px-6 py-12 text-center">
            <div className="text-[14px] font-medium text-[#18181b]">No domains yet</div>
            <p className="mt-1 text-[13px] text-[#71717a]">Add a domain to send outreach from your own address.</p>
          </div>
        )}

        {domains.map((dom) => {
          const status = DOMAIN_STATUS[dom.status];
          const StatusIcon = status.icon;
          return (
            <section key={dom.id} className="rounded-xl border border-[#e8e8e3] overflow-hidden">
              <header className="px-4 sm:px-5 py-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[#f0f0eb]">
                <h3 className="font-mono text-[14px] font-semibold text-[#18181b]">{dom.domain}</h3>
                <span
                  className={`inline-flex items-center gap-1 text-[12px] px-2 py-0.5 rounded-full ${status.className}`}
                >
                  <StatusIcon className="w-3.5 h-3.5" />
                  {status.label}
                </span>
                <span className="text-[12px] text-[#a1a1aa]">
                  {dom.verified_at
                    ? `Verified ${new Date(dom.verified_at).toLocaleDateString([], {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}`
                    : 'DNS changes can take up to 48 hours'}
                </span>
                {dom.status !== 'verified' && (
                  <button
                    type="button"
                    onClick={() => handleCheck(dom)}
                    disabled={checkingId === dom.id}
                    className="ml-auto inline-flex items-center gap-1.5 h-8 px-3 text-[13px] text-[#18181b] border border-[#e8e8e3] rounded-md hover:bg-[#f4f4f0] cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${checkingId === dom.id ? 'animate-spin' : ''}`} />
                    {checkingId === dom.id ? 'Checking…' : 'Check DNS'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleRemove(dom)}
                  className={`${dom.status === 'verified' ? 'ml-auto ' : ''}p-2 rounded-md text-[#a1a1aa] hover:text-red-600 hover:bg-red-50 cursor-pointer`}
                  aria-label={`Remove ${dom.domain}`}
                  title="Remove domain"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </header>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left">
                  <thead>
                    <tr className="text-[11px] font-medium text-[#a1a1aa] bg-[#fafaf8]">
                      <th className="px-4 sm:px-5 py-2 w-16 font-medium">Type</th>
                      <th className="px-3 py-2 w-[38%] font-medium">Host</th>
                      <th className="px-3 py-2 font-medium">Value</th>
                      <th className="px-4 sm:px-5 py-2 w-20 font-medium text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#f0f0eb]">
                    {dom.dns_records.map((rec, idx) => {
                      const recStatus = RECORD_STATUS[rec.status];
                      return (
                        <tr key={idx} className="hover:bg-[#fafaf8]">
                          <td className="px-4 sm:px-5 py-2.5 text-[12px] font-medium text-[#18181b]">{rec.type}</td>
                          <td className="px-3 py-2.5 max-w-0">
                            <CopyCell
                              value={rec.host}
                              copied={copiedKey === `${dom.id}_${idx}_host`}
                              onCopy={() => handleCopy(`${dom.id}_${idx}_host`, rec.host)}
                            />
                          </td>
                          <td className="px-3 py-2.5 max-w-0">
                            <CopyCell
                              value={rec.value}
                              copied={copiedKey === `${dom.id}_${idx}_value`}
                              onCopy={() => handleCopy(`${dom.id}_${idx}_value`, rec.value)}
                            />
                          </td>
                          <td className={`px-4 sm:px-5 py-2.5 text-[12px] text-right ${recStatus.className}`}>
                            {recStatus.label}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {dom.status === 'verified' && <HostedMailboxForm domain={dom} />}
            </section>
          );
        })}
      </div>
    </div>
  );
};

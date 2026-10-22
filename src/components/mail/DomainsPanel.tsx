import React, { useEffect, useRef, useState } from 'react';
import {
  Plus,
  Copy,
  Check,
  Trash2,
  Clock,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  ExternalLink,
  Zap,
  Loader2,
  ChevronDown,
} from 'lucide-react';
import { mailStore, useMailStore, type DomainSetupInfo } from './mail-store';
import { useEcho } from '../../context/EchoContext';
import { useAuth } from '../../context/AuthContext';
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

/** Short, provider-specific steps for adding the records by hand. */
const PROVIDER_GUIDES: Record<string, string[]> = {
  cloudflare: [
    'Open your domain in Cloudflare and go to DNS → Records.',
    'Click “Add record” for each row below. Set Proxy status to “DNS only” (grey cloud).',
    'Save. Cloudflare usually applies changes within a minute.',
  ],
  godaddy: [
    'In GoDaddy, open My Products → your domain → DNS.',
    'Click “Add New Record” for each row below and paste the Type, Name and Value.',
    'Save. Changes usually show up within 30 minutes.',
  ],
  namecheap: [
    'In Namecheap, go to Domain List → Manage → Advanced DNS.',
    'Under Host Records, click “Add New Record” for each row below.',
    'Click the green check to save each one.',
  ],
  hostinger: [
    'In hPanel, open Domains → your domain → DNS / Nameservers.',
    'Add each record below under “Manage DNS records”.',
    'Save. Changes can take up to an hour.',
  ],
  route53: [
    'In the AWS console, open Route 53 → Hosted zones → your domain.',
    'Click “Create record” for each row below. Wrap TXT values in quotes.',
    'Save the records.',
  ],
  google: [
    'Google Domains moved to Squarespace: open Domains → your domain → DNS.',
    'Under Custom records, add each row below.',
    'Save.',
  ],
  squarespace: [
    'In Squarespace, open Domains → your domain → DNS.',
    'Under Custom records, add each row below.',
    'Save.',
  ],
};

const GENERIC_GUIDE = [
  'Sign in where you bought the domain (or where its DNS is hosted) and open its DNS settings.',
  'Add each record below — copy the Host and Value exactly.',
  'Save. Echo checks automatically and lets you know when it’s verified.',
];

const isPendingStatus = (s: MailDomain['status']) => s === 'pending' || s === 'verifying';

/** Fast checks for the first 10 minutes, then slower, then leave it to the server's 10-minute cron. */
const POLL_FAST_MS = 15_000;
const POLL_SLOW_MS = 60_000;
const POLL_FAST_FOR_MS = 10 * 60_000;
const POLL_STOP_AFTER_MS = 60 * 60_000;

const agoLabel = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
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
      <Copy className="w-3.5 h-3.5 shrink-0 text-[#c4c4bf] opacity-0 group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100" />
    )}
  </button>
);

/** Creates a sending address (alex@domain) on a verified domain. */
const HostedMailboxForm: React.FC<{ domain: MailDomain; initialLocalPart?: string }> = ({ domain, initialLocalPart }) => {
  const { mailboxes } = useMailStore();
  const { profile } = useAuth();
  const { addToast } = useEcho();
  const existing = mailboxes.filter((m) => m.domain_id === domain.id);
  // Prefill only while the domain has no address yet (the server may already have created it).
  const [localPart, setLocalPart] = useState(existing.length === 0 ? initialLocalPart || '' : '');
  const [displayName, setDisplayName] = useState(profile?.full_name || '');
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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
    setFormError(null);
    addToast(`${res.mailbox.address} is ready to send.`, 'success');
  };

  const inputClass =
    'h-9 px-3 text-[13px] text-[#18181b] bg-white border border-[#e8e8e3] rounded-md placeholder:text-[#c4c4bf] focus:outline-none focus:border-[#a1a1aa]';

  return (
    <form onSubmit={handleSubmit} className="px-4 sm:px-5 py-4 border-t border-[#f0f0eb] bg-[#fafaf8]" noValidate>
      <div className="text-[13px] font-medium text-[#18181b]">
        {existing.length > 0 ? 'Sending addresses' : 'Create your first address'}
      </div>
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

const STEPS = ['Add', 'Connect DNS', 'Verified'] as const;

const Stepper: React.FC<{ status: MailDomain['status'] }> = ({ status }) => {
  const current = status === 'verified' ? 3 : 2;
  const failed = status === 'failed' || status === 'suspended';
  return (
    <ol className="flex items-center gap-2 text-[12px]" aria-label="Setup progress">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const done = n < current || (n === 3 && status === 'verified');
        const active = n === current && !done;
        return (
          <li key={label} className="flex items-center gap-2" aria-current={active ? 'step' : undefined}>
            <span
              className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-semibold ${
                done
                  ? 'bg-emerald-600 text-white'
                  : active
                    ? failed
                      ? 'bg-red-50 text-red-700 ring-1 ring-red-200'
                      : 'bg-[#18181b] text-white'
                    : 'bg-[#f0f0eb] text-[#a1a1aa]'
              }`}
            >
              {done ? <Check className="w-3 h-3" /> : n}
            </span>
            <span className={done || active ? 'text-[#18181b]' : 'text-[#a1a1aa]'}>{label}</span>
            {n < STEPS.length && <span className="w-6 h-px bg-[#e8e8e3]" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
};

const DomainCard: React.FC<{ dom: MailDomain; setup?: DomainSetupInfo }> = ({ dom, setup }) => {
  const { addToast } = useEcho();
  const [isChecking, setIsChecking] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [lastChecked, setLastChecked] = useState<number | null>(() =>
    dom.last_checked_at ? Date.parse(dom.last_checked_at) || null : null
  );
  const [now, setNow] = useState(() => Date.now());
  const [pollStopped, setPollStopped] = useState(false);
  const inFlight = useRef(false);
  const prevStatus = useRef(dom.status);
  const mounted = useRef(true);

  const pending = isPendingStatus(dom.status);
  const provider = setup?.dns_provider || null;
  const providerName = setup?.domain_connect?.provider_name || provider?.name || null;
  const canAutoConnect = Boolean(setup?.domain_connect?.supported);
  const guide = (provider && PROVIDER_GUIDES[provider.id]) || GENERIC_GUIDE;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Celebrate the flip to verified, whether it came from our poll, a manual
  // check, or the server's cron (picked up by a reload).
  useEffect(() => {
    if (prevStatus.current !== 'verified' && dom.status === 'verified') {
      addToast(`${dom.domain} is verified. You can send from it now.`, 'success');
    }
    prevStatus.current = dom.status;
  }, [dom.status, dom.domain, addToast]);

  const check = async (manual: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (manual) setIsChecking(true);
    if (manual) setPollStopped(false);
    const res = await mailStore.verifyDomain(dom.id);
    inFlight.current = false;
    if (!mounted.current) return;
    setLastChecked(Date.now());
    if (manual) {
      setIsChecking(false);
      if ('error' in res) addToast(res.error, 'error');
      else if (res.domain.status !== 'verified') {
        addToast('Not verified yet. DNS changes can take a while to appear — Echo keeps checking.', 'info');
      }
    }
  };
  const checkRef = useRef(check);
  useEffect(() => {
    checkRef.current = check;
  });

  // Auto-poll while this pending card is on screen.
  useEffect(() => {
    if (!pending) return;
    const startedAt = Date.now();
    let timer = 0;
    let cancelled = false;
    const schedule = () => {
      const elapsed = Date.now() - startedAt;
      if (elapsed > POLL_STOP_AFTER_MS) {
        setPollStopped(true);
        return;
      }
      timer = window.setTimeout(
        async () => {
          if (cancelled) return;
          if (document.visibilityState === 'visible') await checkRef.current(false);
          if (!cancelled) schedule();
        },
        elapsed > POLL_FAST_FOR_MS ? POLL_SLOW_MS : POLL_FAST_MS
      );
    };
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pending, dom.id]);

  // Ticks the "last checked 12s ago" line.
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [pending]);

  const handleCopy = async (key: string, val: string) => {
    try {
      await navigator.clipboard.writeText(val);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    } catch {
      addToast('Could not copy. Select the text and copy it manually.', 'error');
    }
  };

  const handleRemove = async () => {
    if (!window.confirm(`Remove ${dom.domain}? Mailboxes on this domain will stop sending.`)) return;
    const res = await mailStore.removeDomain(dom.id);
    if ('error' in res) addToast(res.error, 'error');
    else addToast(`${dom.domain} removed.`, 'info');
  };

  const handleAutoConnect = async () => {
    if (isConnecting) return;
    // Open the popup inside the click so it isn't blocked, then point it at the signed URL.
    const popup = window.open('', 'echo-domain-connect', 'width=640,height=760');
    setIsConnecting(true);
    const res = await mailStore.domainConnectUrl(dom.id);
    setIsConnecting(false);
    if ('error' in res) {
      popup?.close();
      addToast(res.error, res.notConfigured ? 'info' : 'error');
      return;
    }
    if (!popup || popup.closed) {
      // Popups blocked: fall back to a new tab.
      window.open(res.url, '_blank', 'noopener');
    } else {
      // The provider's page gets no handle back to Echo.
      popup.opener = null;
      popup.location.href = res.url;
      // Check right away once the user is done at their provider.
      const watch = window.setInterval(() => {
        if (popup.closed) {
          window.clearInterval(watch);
          if (mounted.current) void checkRef.current(false);
        }
      }, 1000);
    }
  };

  const status = DOMAIN_STATUS[dom.status];
  const StatusIcon = status.icon;

  const statusLine = (() => {
    if (!pending) return null;
    if (isChecking) return 'Checking DNS…';
    const last = lastChecked ? `last checked ${agoLabel(now - lastChecked)}` : 'waiting for first check';
    if (pollStopped) return `Echo keeps checking every 10 minutes in the background · ${last}`;
    return `Checking DNS automatically · ${last}`;
  })();

  const hasReceivingMx = dom.dns_records.some((r) => r.purpose === 'receiving');

  const recordsTable = (
    <div className="overflow-x-auto">
      {hasReceivingMx && (
        <p className="px-4 sm:px-5 py-2.5 text-[12px] text-amber-800 bg-amber-50 border-b border-amber-100">
          The <span className="font-medium">MX</span> record sends replies for this domain to Echo. If this domain already
          receives email elsewhere (Google Workspace, Outlook, Zoho), adding it will move that mail to Echo. Use a separate
          outreach domain or subdomain instead.
        </p>
      )}
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
            const recStatus = RECORD_STATUS[rec.status] || RECORD_STATUS.pending;
            return (
              <tr key={idx} className="hover:bg-[#fafaf8]">
                <td className="px-4 sm:px-5 py-2.5 text-[12px] font-medium text-[#18181b]">{rec.type}</td>
                <td className="px-3 py-2.5 max-w-0">
                  <CopyCell
                    value={rec.host}
                    copied={copiedKey === `${idx}_host`}
                    onCopy={() => handleCopy(`${idx}_host`, rec.host)}
                  />
                </td>
                <td className="px-3 py-2.5 max-w-0">
                  <CopyCell
                    value={rec.value}
                    copied={copiedKey === `${idx}_value`}
                    onCopy={() => handleCopy(`${idx}_value`, rec.value)}
                  />
                </td>
                <td className={`px-4 sm:px-5 py-2.5 text-[12px] text-right ${recStatus.className}`}>{recStatus.label}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <section className="rounded-xl border border-[#e8e8e3] overflow-hidden">
      <header className="px-4 sm:px-5 py-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[#f0f0eb]">
        <h3 className="font-mono text-[14px] font-semibold text-[#18181b]">{dom.domain}</h3>
        <span className={`inline-flex items-center gap-1 text-[12px] px-2 py-0.5 rounded-full ${status.className}`}>
          <StatusIcon className="w-3.5 h-3.5" />
          {status.label}
        </span>
        {providerName && (
          <span className="text-[12px] px-2 py-0.5 rounded-full bg-[#f4f4f0] text-[#52525b]" title="Where this domain's DNS is hosted">
            DNS: {providerName}
          </span>
        )}
        {dom.verified_at && (
          <span className="text-[12px] text-[#a1a1aa]">
            Verified{' '}
            {new Date(dom.verified_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {dom.status !== 'verified' && (
            <button
              type="button"
              onClick={() => check(true)}
              disabled={isChecking}
              className="inline-flex items-center gap-1.5 h-8 px-3 text-[13px] text-[#18181b] border border-[#e8e8e3] rounded-md hover:bg-[#f4f4f0] cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
              {isChecking ? 'Checking…' : 'Check now'}
            </button>
          )}
          <button
            type="button"
            onClick={handleRemove}
            className="p-2 rounded-md text-[#a1a1aa] hover:text-red-600 hover:bg-red-50 cursor-pointer"
            aria-label={`Remove ${dom.domain}`}
            title="Remove domain"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </header>

      <div className="px-4 sm:px-5 py-3 border-b border-[#f0f0eb] flex flex-wrap items-center justify-between gap-2">
        <Stepper status={dom.status} />
        {statusLine && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-[#71717a]" aria-live="polite">
            <Loader2 className={`w-3.5 h-3.5 ${pollStopped ? '' : 'animate-spin'} text-[#a1a1aa]`} />
            {statusLine}
          </span>
        )}
      </div>

      {dom.status !== 'verified' && (
        <div className="px-4 sm:px-5 py-4 border-b border-[#f0f0eb] space-y-3">
          {(dom.status === 'failed' || dom.status === 'suspended') && (
            <p className="text-[12px] text-red-700">
              {dom.status === 'failed'
                ? 'Verification failed. Check the records below match exactly, then click Check now.'
                : 'This domain is suspended and cannot send.'}
            </p>
          )}

          {canAutoConnect && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[#e8e8e3] bg-[#fafaf8] px-4 py-3">
              <div className="flex-1 min-w-[14rem]">
                <div className="text-[13px] font-medium text-[#18181b]">Set up automatically</div>
                <p className="text-[12px] text-[#71717a]">
                  Sign in to {providerName || 'your DNS provider'} and approve — Echo adds the records for you.
                </p>
              </div>
              <button
                type="button"
                onClick={handleAutoConnect}
                disabled={isConnecting}
                className="inline-flex items-center gap-1.5 h-9 px-4 bg-[#18181b] hover:bg-black text-white text-[13px] font-medium rounded-lg cursor-pointer disabled:opacity-50"
              >
                {isConnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                Set up automatically
              </button>
            </div>
          )}

          <div>
            <div className="text-[13px] font-medium text-[#18181b]">
              {canAutoConnect ? 'Or add the records yourself' : `Add these records${providerName ? ` in ${providerName}` : ''}`}
            </div>
            <ol className="mt-1.5 space-y-1 text-[12px] text-[#71717a] list-decimal pl-4">
              {guide.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            {provider?.dns_url && /^https:\/\//i.test(provider.dns_url) && (
              <a
                href={provider.dns_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-[#18181b] underline underline-offset-2"
              >
                Open {provider.name} DNS settings
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
            <p className="mt-2 text-[12px] text-[#a1a1aa]">
              Click any Host or Value to copy it. If your provider adds “{dom.domain}” to names automatically, paste only
              the part before it.
            </p>
          </div>
        </div>
      )}

      {dom.status === 'verified' ? (
        <details className="group border-b border-[#f0f0eb] last:border-b-0">
          <summary className="list-none px-4 sm:px-5 py-2.5 flex items-center gap-1.5 text-[12px] text-[#71717a] hover:text-[#18181b] cursor-pointer">
            <ChevronDown className="w-3.5 h-3.5 transition-transform group-open:rotate-180" />
            DNS records
          </summary>
          {recordsTable}
        </details>
      ) : (
        recordsTable
      )}

      {dom.status === 'verified' && <HostedMailboxForm domain={dom} initialLocalPart={setup?.local_part} />}
    </section>
  );
};

export const DomainsPanel: React.FC = () => {
  const { domains, domainSetup } = useMailStore();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { addToast } = useEcho();
  const [newDomainName, setNewDomainName] = useState('');
  const [newLocalPart, setNewLocalPart] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const previewDomain = newDomainName.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

  const resetForm = () => {
    setIsAdding(false);
    setNewDomainName('');
    setNewLocalPart('');
    setFormError(null);
  };

  const handleAddDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    const res = await mailStore.addDomain(newDomainName, newLocalPart);
    setIsSubmitting(false);
    if ('error' in res) {
      setFormError(res.error);
      return;
    }
    resetForm();
    addToast(`${res.domain.domain} added. Connect its DNS below — Echo checks automatically.`, 'success');
  };

  const inputClass =
    'h-9 px-3 text-[13px] font-mono text-[#18181b] bg-white border border-[#e8e8e3] placeholder:text-[#c4c4bf] focus:outline-none focus:border-[#a1a1aa]';

  return (
    <div className="flex-1 overflow-y-auto bg-white">
      <div className="max-w-4xl mx-auto px-4 sm:px-8 py-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h2 className="text-[19px] font-semibold text-[#18181b]">Domains & DNS</h2>
            <p className="mt-1 text-[13px] text-[#71717a] max-w-xl">
              Send from your own domain in three steps: add it, connect its DNS, and Echo verifies it for you. Use a
              separate outreach domain (like trycompany.com) to protect your main domain’s reputation.
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
          <form onSubmit={handleAddDomain} className="rounded-xl border border-[#e8e8e3] bg-[#fafaf8] p-4 space-y-3" noValidate>
            <Stepper status="pending" />
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="new-domain" className="block text-[12px] font-medium text-[#52525b] mb-1.5">
                  Domain
                </label>
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
                  className={`${inputClass} w-full rounded-md`}
                />
              </div>
              <div>
                <label htmlFor="new-domain-local" className="block text-[12px] font-medium text-[#52525b] mb-1.5">
                  Address to create <span className="font-normal text-[#a1a1aa]">(optional)</span>
                </label>
                <div className="flex items-center min-w-0">
                  <input
                    id="new-domain-local"
                    type="text"
                    value={newLocalPart}
                    onChange={(e) => {
                      setNewLocalPart(e.target.value.replace(/\s+/g, '').toLowerCase());
                      setFormError(null);
                    }}
                    placeholder="hello"
                    autoComplete="off"
                    className={`${inputClass} flex-1 min-w-0 rounded-l-md`}
                  />
                  <span className="h-9 px-2.5 flex items-center text-[12px] font-mono text-[#71717a] border border-l-0 border-[#e8e8e3] rounded-r-md bg-white truncate max-w-[60%]">
                    @{previewDomain || 'yourdomain.com'}
                  </span>
                </div>
              </div>
            </div>
            <p className="text-[12px] text-[#a1a1aa]">Echo creates this address as soon as the domain is verified.</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={resetForm}
                className="h-9 px-3.5 text-[13px] text-[#52525b] rounded-lg hover:bg-[#f0f0eb] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex items-center gap-1.5 h-9 px-4 bg-[#18181b] hover:bg-black text-white text-[13px] font-medium rounded-lg cursor-pointer disabled:opacity-50"
              >
                {isSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {isSubmitting ? 'Adding…' : 'Add domain'}
              </button>
            </div>
            {formError && (
              <p role="alert" className="text-[12px] text-red-600">
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

        {domains.map((dom) => (
          <DomainCard key={dom.id} dom={dom} setup={domainSetup[dom.id]} />
        ))}
      </div>
    </div>
  );
};

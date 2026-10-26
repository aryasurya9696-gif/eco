import React, { useEffect, useState } from 'react';
import { AlertCircle, Loader2, Unlink } from 'lucide-react';
import { useEcho } from '../../context/EchoContext';
import { PlatformBadge } from '../common/PlatformBadge';
import { usePricing } from '../../lib/pricing';
import { formatCredits } from '../../lib/billing';
import { SOCIAL_LABEL, socialStore, useSocialAccounts, type SocialPlatform } from '../../lib/social';

const FEED_PLATFORM: Record<SocialPlatform, 'twitter' | 'reddit'> = { x: 'twitter', reddit: 'reddit' };

const RETURN_REASONS: Record<string, string> = {
  denied: 'You cancelled the connection.',
  expired: 'The connection took too long. Please try again.',
  token_exchange_failed: 'The platform did not confirm the connection. Please try again.',
  profile_unavailable: 'Could not read your profile from the platform. Please try again.',
};

/**
 * Settings → Connected social accounts. Connect sends the browser to the
 * platform's consent screen; it returns here with ?social=connected|error,
 * which is reported once and then removed from the address bar.
 */
export const SocialAccountsPanel: React.FC = () => {
  const { addToast } = useEcho();
  const { accounts, platforms, loaded, loading, error } = useSocialAccounts();
  const { creditsFor } = usePricing();
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('social');
    if (!outcome) return;
    if (outcome === 'connected') {
      const platform = params.get('platform');
      addToast(`${platform === 'reddit' ? 'Reddit' : 'X'} account connected. You can now reply from the feed.`, 'success');
      void socialStore.load(true);
    } else {
      addToast(RETURN_REASONS[params.get('reason') || ''] || 'Could not connect the account. Please try again.', 'error');
    }
    for (const key of ['social', 'platform', 'reason']) params.delete(key);
    const search = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
  }, [addToast]);

  const connect = async (platform: SocialPlatform) => {
    setBusy(platform);
    try {
      await socialStore.connect(platform);
    } catch (err) {
      addToast((err as Error)?.message || 'Could not start the connection.', 'error');
      setBusy(null);
    }
  };

  const disconnect = async (id: string, handle: string) => {
    setBusy(id);
    try {
      await socialStore.disconnect(id);
      addToast(`Disconnected @${handle}.`, 'success');
    } catch (err) {
      addToast((err as Error)?.message || 'Could not disconnect the account.', 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!loaded && loading) {
    return (
      <p className="flex items-center gap-2 text-xs font-mono text-[#8a8a86]">
        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> Loading connected accounts…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="flex items-center gap-2 text-xs text-[#8a4b00] bg-amber-50 border border-amber-200 px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden /> {error}
        </p>
      )}

      {accounts.length > 0 && (
        <ul className="divide-y divide-[#eeeeea] border border-[#e3e3de]">
          {accounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="flex items-center gap-2.5 min-w-0">
                <PlatformBadge platform={FEED_PLATFORM[a.platform]} size={18} />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-[#141414] truncate">
                    {a.platform === 'reddit' ? 'u/' : '@'}
                    {a.handle}
                  </span>
                  <span className="block text-[11px] font-mono text-[#8a8a86]">
                    {a.status === 'needs_reauth'
                      ? 'Needs reconnecting'
                      : `Up to ${a.daily_reply_cap} replies a day · ${formatCredits(creditsFor(`social.reply.${a.platform}`))} cr each`}
                  </span>
                </span>
              </span>
              <span className="flex items-center gap-2 shrink-0">
                {a.status === 'needs_reauth' && (
                  <button
                    type="button"
                    onClick={() => void connect(a.platform)}
                    disabled={busy !== null}
                    className="px-2.5 py-1.5 text-[11px] font-mono bg-[#141414] text-white hover:bg-black cursor-pointer disabled:opacity-50"
                  >
                    Reconnect
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void disconnect(a.id, a.handle)}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono border border-[#deded8] text-[#4a4a47] hover:bg-[#f6f6f4] cursor-pointer disabled:opacity-50"
                >
                  {busy === a.id ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> : <Unlink className="w-3 h-3" aria-hidden />}
                  Disconnect
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        {(['x', 'reddit'] as const).map((p) => {
          const available = platforms.includes(p);
          return (
            <button
              key={p}
              type="button"
              onClick={() => void connect(p)}
              disabled={!available || busy !== null}
              title={available ? undefined : `${SOCIAL_LABEL[p]} replies are not set up on this workspace yet.`}
              className="inline-flex items-center gap-2 px-3 py-2 text-xs font-mono border border-[#deded8] bg-white text-[#141414] hover:bg-[#f6f6f4] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === p ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <PlatformBadge platform={FEED_PLATFORM[p]} size={14} />}
              Connect {SOCIAL_LABEL[p]}
            </button>
          );
        })}
      </div>

      <p className="text-[11px] font-mono text-[#8a8a86] max-w-prose">
        Echo only posts when you press Send on a reply you can see. It never replies on its own. Disconnecting revokes Echo's access.
      </p>
    </div>
  );
};

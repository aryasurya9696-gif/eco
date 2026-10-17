import React from 'react';
import { providerStyle } from '../../lib/leads';

/**
 * The pastel chip that names the provider behind a result.
 *
 * Colour is matched on the endpoint's prefix rather than an exact id, because
 * the attempt log records `quickenrich.people.email.find` while the UI talks
 * about "QuickEnrich", and a new endpoint on a provider already in the list then
 * colours correctly without anyone touching this file or the palette.
 *
 * Ink on chip is the provider's own darker hue, never the chip colour as text —
 * the pastel fills are far too light to read.
 */
export const ProviderChip: React.FC<{
  endpointId: string | null | undefined;
  /** Compact drops the label and shows the dot alone. */
  compact?: boolean;
  size?: 'sm' | 'md';
  title?: string;
}> = ({ endpointId, compact = false, size = 'sm', title }) => {
  // No provider means no attempt was made, which is different from an attempt
  // that failed. Rendering a grey "Provider" chip there would imply we asked
  // somebody and they said no.
  if (!endpointId) return null;

  const s = providerStyle(endpointId);
  const pad = size === 'md' ? 'px-2 py-0.5 text-[10px]' : 'px-1.5 py-0.5 text-[9px]';

  return (
    <span
      className={`inline-flex items-center gap-1 font-mono uppercase tracking-wider ${pad} ${s.chip} ${s.ink} rounded-none whitespace-nowrap`}
      title={title ?? s.label}
    >
      {!compact && <span>{s.label}</span>}
      <span
        className="w-1 h-1 rounded-full"
        style={{ backgroundColor: 'currentColor' }}
        aria-hidden="true"
      />
    </span>
  );
};

/** The bare dot, for table cells where the column is narrow. */
export const ProviderDot: React.FC<{
  endpointId: string | null | undefined;
  title?: string;
}> = ({ endpointId, title }) => {
  if (!endpointId) return <span className="text-[#b5b5ad] text-[10px] font-mono">—</span>;
  const s = providerStyle(endpointId);
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${s.ink}`}
      title={title ?? s.label}
      aria-label={s.label}
    />
  );
};

/**
 * Echo Leads — small shared controls for filters and selections
 * ---------------------------------------------------------------------------
 * OptionPick   multi-select over a provider vocabulary (value + label), with a
 *              filter box once the list is long enough to need one.
 * Chip         a removable filter chip, for the "active filters" strip.
 * Drawer       the right-hand detail panel that opens over a table without
 *              leaving it.
 */
import React from 'react';
import { X, Check } from 'lucide-react';

export const OptionPick: React.FC<{
  label: string;
  options: Array<{ value: string; label: string }>;
  values: string[];
  onChange: (v: string[]) => void;
  loading?: boolean;
  hint?: string;
}> = ({ label, options, values, onChange, loading = false, hint }) => {
  const [filter, setFilter] = React.useState('');
  const shown = filter
    ? options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase()))
    : options;
  const long = options.length > 14;
  const toggle = (v: string) => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted">{label}</span>
        {values.length > 0 && (
          <button onClick={() => onChange([])} className="text-[10px] font-mono text-muted hover:text-ink cursor-pointer">
            clear
          </button>
        )}
      </div>
      {hint && <p className="text-[10px] font-mono text-muted mb-1.5">{hint}</p>}
      {loading ? (
        <div className="text-[11px] font-mono text-muted">Loading options…</div>
      ) : options.length === 0 ? (
        <div className="text-[11px] font-mono text-muted">No options available from the provider right now.</div>
      ) : (
        <>
          {long && (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${label.toLowerCase()}…`}
              aria-label={`Filter ${label}`}
              className="w-full mb-1.5 bg-transparent text-xs font-mono px-2 py-1 border border-line focus:outline-none focus:ring-1 focus:ring-ink"
            />
          )}
          <div className={`flex flex-wrap gap-1 ${long ? 'max-h-40 overflow-y-auto' : ''}`} role="group" aria-label={label}>
            {shown.map((o) => {
              const on = values.includes(o.value);
              return (
                <button
                  key={o.value}
                  onClick={() => toggle(o.value)}
                  aria-pressed={on}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono border transition-colors cursor-pointer ${
                    on ? 'bg-ink border-ink text-white' : 'border-line text-ink-2 hover:border-ink'
                  }`}
                >
                  {on && <Check className="w-3 h-3" />}
                  {o.label}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

export const Chip: React.FC<{ label: string; onRemove: () => void }> = ({ label, onRemove }) => (
  <span className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 text-[11px] font-mono bg-fill text-ink border border-line">
    {label}
    <button onClick={onRemove} className="p-0.5 text-muted hover:text-ink cursor-pointer" aria-label={`Remove ${label}`}>
      <X className="w-3 h-3" />
    </button>
  </span>
);

export const Drawer: React.FC<{ title: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }> = ({
  title,
  onClose,
  children,
  footer,
}) => {
  const pressedOutside = React.useRef(false);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
      {/*
        Closes only on a press that starts on the backdrop. A plain onClick
        also fired for the trailing click of the very press that opened the
        panel - the backdrop mounts under the pointer - which on touch screens
        (and some mice) closed the panel the instant it opened.
      */}
      <div
        className="absolute inset-0 bg-black/20"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) pressedOutside.current = true;
        }}
        onPointerUp={(e) => {
          if (pressedOutside.current && e.target === e.currentTarget) onClose();
          pressedOutside.current = false;
        }}
        aria-hidden="true"
      />
      <aside className="relative w-full max-w-md h-full bg-white border-l border-line flex flex-col shadow-xl">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-line-soft">
          <div className="min-w-0">{title}</div>
          <button onClick={onClose} className="text-muted hover:text-ink cursor-pointer flex-shrink-0" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">{children}</div>
        {footer && <div className="border-t border-line-soft px-5 py-3">{footer}</div>}
      </aside>
    </div>
  );
};

/** A label and value pair in a detail panel. Absent values say so rather than render blank. */
export const Field: React.FC<{ label: string; children?: React.ReactNode; source?: string | null }> = ({ label, children, source }) => (
  <div className="grid grid-cols-[110px_1fr] gap-3 text-xs">
    <span className="text-[10px] font-mono uppercase tracking-wider text-muted pt-0.5">{label}</span>
    <span className="font-mono text-ink break-words min-w-0">
      {children === null || children === undefined || children === '' ? <span className="text-faint">Not available</span> : children}
      {source && <span className="block text-[10px] text-muted mt-0.5">via {source}</span>}
    </span>
  </div>
);

export const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-[10px] font-mono uppercase tracking-wider text-muted mb-2">{children}</div>
);

/** The fit score as a small badge, with its label and nothing implying probability. */
export const ScoreBadge: React.FC<{ score: number | null; label: string | null }> = ({ score, label }) => {
  if (score === null || score === undefined) {
    return (
      <span className="text-[10px] font-mono text-muted" title={label ?? 'Not scored yet'}>
        {label === 'Not enough data' ? 'n/a' : '—'}
      </span>
    );
  }
  const tone = score >= 70 ? 'bg-ok-bg text-ok' : score >= 40 ? 'bg-warn-bg text-warn' : 'bg-line-soft text-ink-2';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono tabular-nums ${tone}`} title={`${label ?? ''} - fit with your scoring rules, not a probability`}>
      {score}
    </span>
  );
};

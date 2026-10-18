import React from 'react';

/**
 * The frame every Leads sub-view sits in.
 *
 * Leads had no page furniture at all — each sub-view started straight into
 * content, edge to edge, so at a wide viewport the run card was a thin strip
 * stretched across 1600px and the screen below it was empty. Billing and Feed
 * both open with an h1 and a line of mono underneath, and the cost of Leads not
 * doing so was that it read as a prototype next to them.
 *
 * max-w-5xl rather than the max-w-4xl the other tabs use. The run table has six
 * columns and gets cramped at 896px; 1024 keeps the form screens comfortable
 * while leaving the table room. Consistency within Leads mattered more than
 * matching the width exactly.
 */
export const Screen: React.FC<{
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  /** A control on the right of the title row: a button, a segmented switch. */
  action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, subtitle, icon, action, children }) => (
  <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
    <header className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <h1 className="text-lg font-medium text-[#141414] flex items-center gap-2">
          {icon && <span className="text-[#8a8a86]">{icon}</span>}
          {title}
        </h1>
        {subtitle && (
          <p className="text-xs text-[#8a8a86] font-mono mt-1 leading-relaxed">{subtitle}</p>
        )}
      </div>
      {action && <div className="flex-shrink-0 pt-0.5">{action}</div>}
    </header>
    {children}
  </div>
);

/**
 * A bordered panel with the section label in the same position on every screen,
 * so the eye learns where labels are once.
 */
export const Panel: React.FC<{
  label: string;
  hint?: React.ReactNode;
  /** The right-hand side of the label row: counters, a save button. */
  aside?: React.ReactNode;
  children: React.ReactNode;
  /** Removes the body padding, for a table that wants to reach the edges. */
  flush?: boolean;
}> = ({ label, hint, aside, children, flush = false }) => (
  <section className="border border-[#e3e3de] bg-white">
    <div className="px-5 py-3 border-b border-[#eeeeea] flex items-center justify-between gap-4">
      <div className="min-w-0">
        <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86]">
          {label}
        </span>
        {hint && <div className="text-[11px] text-[#8a8a86] font-mono mt-1">{hint}</div>}
      </div>
      {aside}
    </div>
    <div className={flush ? '' : 'p-5'}>{children}</div>
  </section>
);

/**
 * The primary action.
 *
 * Square, black, mono — the same one button the whole app has. Width is opt-in
 * rather than default because a button that spans a form reads as a field.
 */
export const Button: React.FC<{
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'quiet';
  full?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  /**
   * Appended last, so a caller can adjust the padding without redeclaring the
   * tones. A shared control that cannot be sized is a control every caller
   * eventually stops using.
   */
  className?: string;
}> = ({ children, onClick, disabled = false, variant = 'primary', full = false, title, type = 'button', className = '' }) => {
  const base =
    'inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-mono transition-colors cursor-pointer disabled:cursor-not-allowed';
  const tone =
    variant === 'primary'
      ? 'bg-[#141414] text-white hover:bg-black disabled:bg-[#e3e3de] disabled:text-[#8a8a86]'
      : variant === 'secondary'
        ? 'border border-[#e3e3de] text-[#4a4a47] hover:border-[#141414] hover:text-[#141414] disabled:opacity-40'
        : 'text-[#8a8a86] hover:text-[#141414] disabled:opacity-40';
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${tone} ${full ? 'w-full' : ''} ${className}`}
    >
      {children}
    </button>
  );
};

/** A single-line text input in the app's voice. */
export const Input: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({
  className = '',
  ...rest
}) => (
  <input
    {...rest}
    className={`w-full bg-transparent text-xs font-mono text-[#141414] placeholder:text-[#b5b5ad] focus:outline-none focus:ring-1 focus:ring-[#141414] px-2 py-1.5 border border-[#e3e3de] ${className}`}
  />
);

export const Textarea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = ({
  className = '',
  ...rest
}) => (
  <textarea
    {...rest}
    className={`w-full bg-transparent text-xs font-mono text-[#141414] placeholder:text-[#b5b5ad] focus:outline-none focus:ring-1 focus:ring-[#141414] px-3 py-2.5 border border-[#e3e3de] resize-y leading-relaxed ${className}`}
  />
);

/**
 * A labelled figure. The number is large because it is the thing being read; the
 * label is small because it is the thing already known. Billing's balance does
 * this at text-3xl and the run cards were doing it at text-base, which made a
 * figure the user is meant to act on look like a caption.
 */
export const Figure: React.FC<{
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'bad';
  size?: 'sm' | 'lg';
  /**
   * The explanation of what the number means, on hover.
   *
   * Kept because it carries something the sub-label cannot: why a figure is what
   * it is. "Duplicates 3" does not say whether they were removed before the run
   * and are therefore free, which is the part a user is checking.
   */
  title?: string;
}> = ({ label, value, sub, tone = 'default', size = 'lg', title }) => {
  const toneClass =
    tone === 'good' ? 'text-[#1a7f4b]' : tone === 'warn' ? 'text-[#b45309]' : tone === 'bad' ? 'text-[#b03a20]' : 'text-[#141414]';
  return (
    <div className="min-w-0" title={title}>
      <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] block">{label}</span>
      <span
        className={`${size === 'lg' ? 'text-2xl' : 'text-sm'} font-mono font-medium tabular-nums leading-tight ${toneClass}`}
      >
        {value}
      </span>
      {sub && <span className="block text-[10px] font-mono text-[#8a8a86] mt-0.5">{sub}</span>}
    </div>
  );
};

/**
 * A segmented switch. Three options is where this stops being tabs and starts
 * being a control, and at that point a radio group styled as a control is
 * clearer than three words with an underline under one of them.
 */
export const Segmented: React.FC<{
  options: Array<{ value: string; label: string; title?: string }>;
  value: string;
  onChange: (v: string) => void;
}> = ({ options, value, onChange }) => (
  <div className="inline-flex border border-[#e3e3de]">
    {options.map((o, i) => (
      <button
        key={o.value}
        onClick={() => onChange(o.value)}
        title={o.title}
        className={`px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider transition-colors cursor-pointer ${
          i > 0 ? 'border-l border-[#e3e3de]' : ''
        } ${
          value === o.value
            ? 'bg-[#141414] text-white'
            : 'text-[#8a8a86] hover:text-[#141414] hover:bg-[#f6f6f4]'
        }`}
      >
        {o.label}
      </button>
    ))}
  </div>
);

/**
 * The bar under a price.
 *
 * Against the worst case, never the estimate: the estimate is what will probably
 * happen and the maximum is the ceiling the wallet is checked against, so a bar
 * drawn to the estimate would look comfortable right up to the moment the run
 * could not be paid for.
 */
export const PriceBar: React.FC<{
  expected: number;
  max: number;
  /** The wallet balance, so the bar can show whether the worst case is covered. */
  balance?: number | null;
}> = ({ expected, max, balance }) => {
  const span = Math.max(max, expected, 1);
  const expectedPct = (expected / span) * 100;
  // Clipped, so a balance larger than the whole range does not overflow the track.
  const coveredPct = balance === null || balance === undefined ? null : Math.min(100, (balance / span) * 100);

  return (
    <div className="w-full">
      <div className="relative h-1.5 w-full bg-[#eeeeea]">
        <div className="absolute inset-y-0 left-0 bg-[#141414] transition-[width] duration-500" style={{ width: `${expectedPct}%` }} />
        {coveredPct !== null && coveredPct < 100 && (
          <div
            className="absolute inset-y-0 border-r border-[#b45309]"
            style={{ left: `${coveredPct}%` }}
            title={`Wallet covers ${Math.round(coveredPct)}% of the worst case`}
          />
        )}
      </div>
      <div className="flex justify-between text-[10px] font-mono text-[#8a8a86] mt-1.5">
        <span>likely {Math.round(expectedPct)}% of the worst case</span>
        {coveredPct !== null && coveredPct < expectedPct && (
          <span className="text-[#b45309]">balance covers {Math.round(coveredPct)}%</span>
        )}
      </div>
    </div>
  );
};

/**
 * What a screen shows instead of a paragraph in a box.
 *
 * The old empty states said what a feature would do one day. This says what is
 * here now, in one line, and offers the action that makes it exist. A panel with
 * a paragraph in it and no way forward is the thing these were replacing.
 */
export const Blank: React.FC<{
  title: string;
  body: string;
  action?: React.ReactNode;
}> = ({ title, body, action }) => (
  <div className="border border-[#e3e3de] bg-white px-8 py-14 flex flex-col items-center text-center">
    <h3 className="text-sm font-medium text-[#141414]">{title}</h3>
    <p className="text-xs font-mono text-[#8a8a86] mt-2 max-w-md leading-relaxed">{body}</p>
    {action && <div className="mt-5">{action}</div>}
  </div>
);
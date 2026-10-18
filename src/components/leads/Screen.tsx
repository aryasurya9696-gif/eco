import React from 'react';
import { createPortal } from 'react-dom';

/**
 * The frame every Leads sub-view sits in.
 *
 * Leads had no page furniture at all — each sub-view started straight into
 * content, edge to edge, so at a wide viewport the run card was a thin strip
 * stretched across 1600px and the screen below it was empty. Billing and Feed
 * both open with an h1 and a line of mono underneath, and the cost of Leads not
 * doing so was that it read as a prototype next to them.
 *
 * No padding of its own: the dashboard's content pane already has it, and a
 * second layer made framed screens sit further in than the rest.
 *
 * max-w-5xl rather than the max-w-4xl the other tabs use. The run table has six
 * columns and gets cramped at 896px; 1024 keeps the form screens comfortable
 * while leaving the table room. Consistency within Leads mattered more than
 * matching the width exactly.
 */
export const Screen: React.FC<{
  title: string;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  /** A control on the right of the title row: a button, a segmented switch. */
  action?: React.ReactNode;
  /** max-w-7xl instead of max-w-5xl, for wide tables and two-column layouts. */
  wide?: boolean;
  children: React.ReactNode;
}> = ({ title, subtitle, icon, action, wide = false, children }) => {
  // Where <ScreenAction> renders, so a view can put its primary button in the
  // header without the frame having to know about it.
  const [slot, setSlot] = React.useState<HTMLDivElement | null>(null);
  return (
    <ScreenSlot.Provider value={slot}>
      <div className={`${wide ? 'max-w-7xl' : 'max-w-5xl'} mx-auto space-y-6`}>
        <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-lg font-medium text-ink flex items-center gap-2">
              {icon && <span className="text-muted">{icon}</span>}
              {title}
            </h1>
            {subtitle && (
              <p className="text-xs text-muted font-mono mt-1 leading-relaxed max-w-2xl">{subtitle}</p>
            )}
          </div>
          <div ref={setSlot} className="flex flex-wrap items-center gap-2 flex-shrink-0 pt-0.5 empty:hidden">
            {action}
          </div>
        </header>
        {children}
      </div>
    </ScreenSlot.Provider>
  );
};

const ScreenSlot = React.createContext<HTMLDivElement | null>(null);

/**
 * Renders its children in the enclosing Screen's header, on the right. Outside
 * a Screen it renders in place.
 */
export const ScreenAction: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const slot = React.useContext(ScreenSlot);
  return slot ? createPortal(children, slot) : <>{children}</>;
};

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
  <section className="border border-line bg-white">
    <div className="px-5 py-3 border-b border-line-soft flex items-center justify-between gap-4">
      <div className="min-w-0">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted">
          {label}
        </span>
        {hint && <div className="text-[11px] text-muted font-mono mt-1">{hint}</div>}
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
      ? 'bg-ink text-white hover:bg-black disabled:bg-line disabled:text-muted'
      : variant === 'secondary'
        ? 'border border-line text-ink-2 hover:border-ink hover:text-ink disabled:opacity-40'
        : 'text-muted hover:text-ink disabled:opacity-40';
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
// ComponentProps rather than InputHTMLAttributes so a ref passes through (React 19).
export const Input: React.FC<React.ComponentProps<'input'>> = ({
  className = '',
  ...rest
}) => (
  <input
    {...rest}
    className={`w-full bg-transparent text-xs font-mono text-ink placeholder:text-faint focus:outline-none focus:ring-1 focus:ring-ink px-2 py-1.5 border border-line ${className}`}
  />
);

export const Textarea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = ({
  className = '',
  ...rest
}) => (
  <textarea
    {...rest}
    className={`w-full bg-transparent text-xs font-mono text-ink placeholder:text-faint focus:outline-none focus:ring-1 focus:ring-ink px-3 py-2.5 border border-line resize-y leading-relaxed ${className}`}
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
    tone === 'good' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-danger-strong' : 'text-ink';
  return (
    <div className="min-w-0" title={title}>
      <span className="text-[10px] font-mono uppercase tracking-wider text-muted block">{label}</span>
      <span
        className={`${size === 'lg' ? 'text-2xl' : 'text-sm'} font-mono font-medium tabular-nums leading-tight ${toneClass}`}
      >
        {value}
      </span>
      {sub && <span className="block text-[10px] font-mono text-muted mt-0.5">{sub}</span>}
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
  <div className="inline-flex border border-line">
    {options.map((o, i) => (
      <button
        key={o.value}
        onClick={() => onChange(o.value)}
        title={o.title}
        className={`px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider transition-colors cursor-pointer ${
          i > 0 ? 'border-l border-line' : ''
        } ${
          value === o.value
            ? 'bg-ink text-white'
            : 'text-muted hover:text-ink hover:bg-surface'
        }`}
      >
        {o.label}
      </button>
    ))}
  </div>
);


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
  <div className="border border-line bg-white px-8 py-14 flex flex-col items-center text-center">
    <h3 className="text-sm font-medium text-ink">{title}</h3>
    <p className="text-xs font-mono text-muted mt-2 max-w-md leading-relaxed">{body}</p>
    {action && <div className="mt-5">{action}</div>}
  </div>
);
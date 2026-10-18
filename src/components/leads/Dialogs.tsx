/**
 * Echo Leads — dialogs
 * ---------------------------------------------------------------------------
 * The rule for what opens where:
 *
 *   a decision   -> a centred Modal: confirm, name something, pay (CostDialog)
 *   details      -> the side Drawer in Pick.tsx: a lead, a company, an editor
 *
 * Modal       the centred shell every decision dialog uses.
 * DialogsProvider / useDialogs
 *             confirm() and prompt() that return a Promise, in place of the
 *             browser's window.confirm / window.prompt, so they look like the
 *             app and a prompt can show a server error (a name already taken)
 *             without closing.
 */
import React from 'react';
import { X, Loader2 } from 'lucide-react';
import { Button, Input } from './Screen';

export const Modal: React.FC<{
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** md for a question, lg for a short form, xl for a list to review. */
  size?: 'md' | 'lg' | 'xl';
  /** While true, Escape, the backdrop and the close button do nothing. */
  busy?: boolean;
}> = ({ title, onClose, children, footer, size = 'md', busy = false }) => {
  const titleId = React.useId();
  const pressedOutside = React.useRef(false);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      // The Drawer reads this: Escape belongs to the dialog on top.
      data-leads-modal=""
      // Same rule as the Drawer: only a press that starts and ends on the
      // backdrop closes, so the click that opened the dialog cannot close it.
      onPointerDown={(e) => {
        pressedOutside.current = e.target === e.currentTarget;
      }}
      onPointerUp={(e) => {
        if (pressedOutside.current && e.target === e.currentTarget && !busy) onClose();
        pressedOutside.current = false;
      }}
    >
      <div className={`w-full ${size === 'xl' ? 'max-w-2xl' : size === 'lg' ? 'max-w-lg' : 'max-w-md'} max-h-[90vh] flex flex-col bg-white border border-line shadow-xl`}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-line-soft">
          <h2 id={titleId} className="text-sm font-medium text-ink">{title}</h2>
          <button onClick={onClose} disabled={busy} className="text-muted hover:text-ink cursor-pointer disabled:opacity-40" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-5 py-3 border-t border-line-soft">{footer}</div>}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// confirm() and prompt()
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  /** Red confirm button, for deleting. */
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  maxLength?: number;
  /**
   * Runs on submit with the trimmed value. Return an error message to keep the
   * dialog open and show it; return nothing to close.
   */
  submit?: (value: string) => Promise<string | null | void> | string | null | void;
}

type Open =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: 'prompt'; opts: PromptOptions; resolve: (value: string | null) => void };

interface DialogsApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** The trimmed value, or null if cancelled or left empty. */
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

const DialogsContext = React.createContext<DialogsApi | null>(null);

export const DialogsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [open, setOpen] = React.useState<Open | null>(null);

  const api = React.useMemo<DialogsApi>(() => ({
    confirm: (opts) => new Promise((resolve) => setOpen({ kind: 'confirm', opts, resolve })),
    prompt: (opts) => new Promise((resolve) => setOpen({ kind: 'prompt', opts, resolve })),
  }), []);

  return (
    <DialogsContext.Provider value={api}>
      {children}
      {open?.kind === 'confirm' && (
        <ConfirmDialog
          {...open.opts}
          onDone={(ok) => {
            open.resolve(ok);
            setOpen(null);
          }}
        />
      )}
      {open?.kind === 'prompt' && (
        <PromptDialog
          {...open.opts}
          onDone={(value) => {
            open.resolve(value);
            setOpen(null);
          }}
        />
      )}
    </DialogsContext.Provider>
  );
};

export function useDialogs(): DialogsApi {
  const api = React.useContext(DialogsContext);
  if (!api) throw new Error('useDialogs must be used inside <DialogsProvider>');
  return api;
}

const ConfirmDialog: React.FC<ConfirmOptions & { onDone: (ok: boolean) => void }> = ({
  title, body, confirmLabel = 'Confirm', danger = false, onDone,
}) => (
  <Modal
    title={title}
    onClose={() => onDone(false)}
    footer={
      <>
        <Button variant="secondary" onClick={() => onDone(false)}>Cancel</Button>
        <Button onClick={() => onDone(true)} className={danger ? '!bg-danger hover:!bg-danger-strong' : ''}>
          {confirmLabel}
        </Button>
      </>
    }
  >
    {body && <div className="text-xs font-mono text-ink-2 leading-relaxed">{body}</div>}
  </Modal>
);

const PromptDialog: React.FC<PromptOptions & { onDone: (value: string | null) => void }> = ({
  title, label, initial = '', placeholder, confirmLabel = 'Save', maxLength = 80, submit, onDone,
}) => {
  const [value, setValue] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const go = async () => {
    const v = value.trim();
    if (!v) return;
    if (!submit) return onDone(v);
    setBusy(true);
    setError(null);
    try {
      const err = await submit(v);
      if (err) setError(err);
      else onDone(v);
    } catch (e) {
      setError((e as Error)?.message ?? 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      busy={busy}
      onClose={() => onDone(null)}
      footer={
        <>
          <Button variant="secondary" onClick={() => onDone(null)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void go()} disabled={busy || !value.trim()}>
            {busy && <Loader2 className="w-3 h-3 animate-spin" />} {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-wider text-muted mb-1">{label}</span>
          <Input
            ref={inputRef}
            value={value}
            maxLength={maxLength}
            placeholder={placeholder}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
        </label>
        {error && <p className="text-[11px] font-mono text-danger mt-2" role="alert">{error}</p>}
      </form>
    </Modal>
  );
};

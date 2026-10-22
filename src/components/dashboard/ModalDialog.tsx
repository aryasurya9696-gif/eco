import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

interface ModalDialogProps {
  /** Visible title; also the dialog's accessible name. */
  title: React.ReactNode;
  /** Called on Escape or a backdrop click. Omit for a dialog that must not be dismissed. */
  onClose?: () => void;
  /** Blocks Escape and backdrop dismissal (e.g. while a request is running). */
  busy?: boolean;
  className?: string;
  /** Rendered instead of the default heading, which must then use `titleId`. */
  renderHeader?: (titleId: string) => React.ReactNode;
  children: React.ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog: role="dialog", aria-modal, labelled by its title, Escape to
 * close, focus moved in on open, kept inside while open, and given back to
 * whatever had it before.
 */
export const ModalDialog: React.FC<ModalDialogProps> = ({
  title,
  onClose,
  busy = false,
  className = 'max-w-sm',
  renderHeader,
  children,
}) => {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  useEffect(() => {
    closeRef.current = onClose;
    busyRef.current = busy;
  });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closeRef.current && !busyRef.current) {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, []);

  // Portalled to <body>: an ancestor with a filter/backdrop-filter (the dashboard
  // header, the blurred main pane) would otherwise become the containing block
  // for `fixed` and pin the dialog inside it instead of centring it on screen.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-xs"
        aria-hidden="true"
        onClick={() => {
          if (onClose && !busy) onClose();
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative w-full bg-white border border-[#e3e3de] shadow-2xl z-10 max-h-[90vh] overflow-y-auto focus:outline-none ${className}`}
      >
        {renderHeader ? (
          renderHeader(titleId)
        ) : (
          <h2 id={titleId} className="px-5 pt-5 text-sm font-bold text-[#141414]">
            {title}
          </h2>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
};

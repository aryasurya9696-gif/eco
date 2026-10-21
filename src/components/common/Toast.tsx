import React from 'react';
import { useToastActions, useToasts } from '../../context/EchoContext';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

const ICONS = {
  success: <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" aria-hidden="true" />,
  error: <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" aria-hidden="true" />,
  info: <Info className="w-4 h-4 text-white flex-shrink-0" aria-hidden="true" />,
};

/**
 * The live region is always mounted (empty when there is nothing to say):
 * screen readers only announce changes to a region that already exists.
 */
export const ToastContainer: React.FC = () => {
  const toasts = useToasts();
  const { dismissToast } = useToastActions();

  return (
    <div
      role="status"
      aria-live="polite"
      aria-relevant="additions"
      className="fixed bottom-6 right-6 left-6 sm:left-auto z-50 flex flex-col gap-2 sm:max-w-sm sm:w-full pointer-events-none"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto flex items-center justify-between gap-3 px-4 py-3 bg-[#141414] text-white text-xs border border-[#262626] rounded-none shadow-xl animate-in slide-in-from-bottom-2 duration-200"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            {ICONS[toast.type]}
            <span className="font-mono tracking-tight break-words">
              {toast.type === 'error' && <span className="sr-only">Error: </span>}
              {toast.message}
            </span>
          </div>
          <button
            type="button"
            onClick={() => dismissToast(toast.id)}
            aria-label="Dismiss notification"
            className="text-[#8a8a86] hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
};

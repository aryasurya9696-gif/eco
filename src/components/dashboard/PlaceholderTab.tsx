import React from 'react';
import { Settings, CreditCard } from 'lucide-react';

interface PlaceholderTabProps {
  type: 'settings' | 'billing';
}

export const PlaceholderTab: React.FC<PlaceholderTabProps> = ({ type }) => {
  const isSettings = type === 'settings';

  return (
    <div className="bg-[#ffffff] border border-[#e3e3de] p-12 max-w-2xl mx-auto my-12 text-center space-y-4">
      <div className="w-12 h-12 bg-[#f6f6f4] border border-[#e3e3de] flex items-center justify-center mx-auto text-[#141414]">
        {isSettings ? (
          <Settings className="w-5 h-5 text-[#8a8a86]" />
        ) : (
          <CreditCard className="w-5 h-5 text-[#8a8a86]" />
        )}
      </div>

      <div className="space-y-1">
        <h3 className="text-base font-semibold text-[#141414]">
          {isSettings ? 'Workspace Settings' : 'Billing & Subscription'}
        </h3>
        <p className="text-xs text-[#8a8a86] font-mono">
          {isSettings
            ? 'Workspace preferences will live here'
            : 'Plans, invoices and payment method.'}
        </p>
      </div>

      <div className="pt-2">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-[#f6f6f4] border border-[#e3e3de] text-[10px] font-mono uppercase tracking-wider text-[#8a8a86]">
          Planned for v2 release
        </span>
      </div>
    </div>
  );
};

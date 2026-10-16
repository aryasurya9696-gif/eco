import React, { useState } from 'react';
import { useEcho } from '../../context/EchoContext';
import { 
  Check, 
  X, 
  Zap, 
  ShieldCheck, 
  CreditCard,
  Layers,
  ArrowRight
} from 'lucide-react';

interface TopUpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const TopUpModal: React.FC<TopUpModalProps> = ({ isOpen, onClose }) => {
  const { creditsBalance, topUpCredits, addToast } = useEcho();
  const [selectedPack, setSelectedPack] = useState<'starter' | 'growth' | 'agency'>('growth');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  if (!isOpen) return null;

  const packs = [
    {
      id: 'starter' as const,
      name: 'Starter Pack',
      credits: 100,
      price: '$29',
      pricePerCredit: '$0.29',
      leadsEstimate: '~33 Leads',
      popular: false,
      desc: 'Perfect for solo founders testing high-intent outbound.',
      features: [
        '100 Verified Lead Credits',
        'Waterfall Email Discovery',
        'AI Outreach Pitches Included',
        'Free Misses (No charge for dead emails)',
        'Never Expires',
      ],
    },
    {
      id: 'growth' as const,
      name: 'Growth Pack',
      credits: 500,
      price: '$99',
      pricePerCredit: '$0.19',
      leadsEstimate: '~166 Leads',
      popular: true,
      desc: 'Most popular for agencies and active sales closers.',
      features: [
        '500 Verified Lead Credits (Save 35%)',
        'Waterfall Email & Domain Finding',
        'Priority Deliverability Verification',
        'Direct CSV & Sheets Export',
        'Instant Refund on Catch-all/Invalid',
      ],
    },
    {
      id: 'agency' as const,
      name: 'Agency Scale Pack',
      credits: 2000,
      price: '$299',
      pricePerCredit: '$0.14',
      leadsEstimate: '~666 Leads',
      popular: false,
      desc: 'Bulk volume for outbound teams and lead brokers.',
      features: [
        '2,000 Verified Lead Credits (Save 52%)',
        'Full Waterfall (5 Providers)',
        'Decision Maker Role Filtering',
        'Dedicated API Webhook Stream',
        'Zero-Risk Hit Guarantee',
      ],
    },
  ];

  const handlePurchase = async () => {
    const pack = packs.find((p) => p.id === selectedPack);
    if (!pack) return;

    setIsProcessing(true);
    try {
      await topUpCredits(pack.credits, pack.name);
      addToast(`Successfully credited ${pack.credits} leads to your balance!`, 'success');
      onClose();
    } catch {
      addToast('Failed to complete credit purchase.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div 
        className="bg-[#ffffff] border border-[#141414] max-w-2xl w-full shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-[#141414] text-white px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center">
              <Zap className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold tracking-tight text-white flex items-center gap-2">
                <span>Top Up Lead Credits</span>
                <span className="px-2 py-0.5 text-[10px] font-mono bg-emerald-500/20 text-emerald-300 rounded-full border border-emerald-500/30">
                  Pay Only For Hits
                </span>
              </h2>
              <p className="text-[11px] font-mono text-[#a3a39e]">
                Current balance: <span className="text-white font-semibold">{creditsBalance} credits</span> · Unused credits never expire
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="text-[#a3a39e] hover:text-white transition-colors cursor-pointer p-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-6">
          {/* Trust Banner */}
          <div className="bg-[#f6f6f4] border border-[#e3e3de] p-3.5 flex items-start gap-3">
            <ShieldCheck className="w-4 h-4 text-emerald-700 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-[#2c2c2a] leading-relaxed">
              <strong className="text-[#141414]">100% Cascade Hit Guarantee:</strong> Each verified lead costs 3 credits. If an email cannot be verified or bounces, your credits are automatically refunded to your ledger.
            </div>
          </div>

          {/* Pricing Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {packs.map((p) => {
              const isSelected = selectedPack === p.id;
              return (
                <div
                  key={p.id}
                  onClick={() => setSelectedPack(p.id)}
                  className={`p-4 border transition-all cursor-pointer relative flex flex-col justify-between ${
                    isSelected
                      ? 'border-[#141414] bg-[#fafaf8] shadow-sm ring-1 ring-[#141414]'
                      : 'border-[#e3e3de] bg-white hover:border-[#8a8a86]'
                  }`}
                >
                  {p.popular && (
                    <div className="absolute -top-2.5 right-3 px-2 py-0.5 bg-[#141414] text-white text-[9px] font-mono uppercase tracking-wider">
                      Most Popular
                    </div>
                  )}

                  <div>
                    <div className="text-xs font-bold text-[#141414]">{p.name}</div>
                    <div className="mt-2 flex items-baseline gap-1">
                      <span className="text-2xl font-bold font-mono text-[#141414]">{p.price}</span>
                      <span className="text-[11px] font-mono text-[#8a8a86]">one-time</span>
                    </div>

                    <div className="mt-1 text-[11px] font-mono text-emerald-700 font-semibold">
                      {p.credits} Credits ({p.leadsEstimate})
                    </div>
                    <div className="text-[10px] font-mono text-[#8a8a86]">
                      {p.pricePerCredit} per credit
                    </div>

                    <div className="mt-4 pt-3 border-t border-[#eeeeea] space-y-2">
                      {p.features.map((feat, idx) => (
                        <div key={idx} className="flex items-start gap-1.5 text-[11px] text-[#4a4a47]">
                          <Check className="w-3 h-3 text-emerald-600 flex-shrink-0 mt-0.5" />
                          <span>{feat}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-4 pt-2">
                    <div className={`w-full py-1.5 text-center text-xs font-mono border transition-colors ${
                      isSelected 
                        ? 'bg-[#141414] text-white border-[#141414]' 
                        : 'bg-white text-[#141414] border-[#e3e3de]'
                    }`}>
                      {isSelected ? 'Selected' : 'Select'}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="bg-[#f6f6f4] border-t border-[#e3e3de] px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-mono text-[#5f5f5a]">
            <Layers className="w-3.5 h-3.5 text-[#141414]" />
            <span>Credits activate immediately on checkout</span>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            <button
              onClick={onClose}
              className="px-4 py-2 border border-[#e3e3de] bg-white text-xs font-mono hover:bg-[#eeeeea] transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handlePurchase}
              disabled={isProcessing}
              className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 px-6 py-2 bg-[#141414] hover:bg-black text-white text-xs font-mono transition-colors cursor-pointer shadow-xs"
            >
              <CreditCard className="w-3.5 h-3.5 text-emerald-400" />
              <span>
                {isProcessing ? 'Activating Credits...' : `Confirm & Add ${packs.find((p) => p.id === selectedPack)?.credits} Credits`}
              </span>
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

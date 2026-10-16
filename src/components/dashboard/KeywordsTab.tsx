import React, { useState } from 'react';
import { useEcho } from '../../context/EchoContext';
import { useAuth } from '../../context/AuthContext';
import { PillInput } from '../common/PillInput';
import { ShieldCheck, Zap, Sparkles, Plus } from 'lucide-react';

export const KeywordsTab: React.FC = () => {
  const { keywords, addKeyword, removeKeyword, suggestKeywordsFromOffer, addToast, sweepTime, lookbackHours } = useEcho();
  const { profile } = useAuth();
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);

  const handleAdd = async (keyword: string) => {
    await addKeyword(keyword);
  };

  const handleRemove = async (keywordText: string) => {
    const target = keywords.find((k) => k.keyword.toLowerCase() === keywordText.toLowerCase());
    if (target) {
      await removeKeyword(target.id);
    }
  };

  const handleGenerateAiKeywords = () => {
    setIsGenerating(true);
    setTimeout(() => {
      const generated = suggestKeywordsFromOffer(profile?.core_offer || profile?.website || '');
      setAiSuggestions(generated);
      setIsGenerating(false);
      addToast('AI analyzed your core offer and generated keyword ideas.', 'success');
    }, 600);
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header card */}
      <div className="bg-[#ffffff] border border-[#e3e3de] p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#eeeeea]">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-[#141414]">
              Tracked Keywords
            </h2>
            <p className="text-xs text-[#8a8a86] font-mono mt-1">
              Active keywords scanned daily across connected social channels and web communities for buyer-intent mentions.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleGenerateAiKeywords}
              disabled={isGenerating || keywords.length >= 10}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#f6f6f4] hover:bg-[#ecece7] border border-[#e3e3de] text-xs font-mono text-[#141414] transition-colors cursor-pointer disabled:opacity-40"
            >
              <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
              <span>{isGenerating ? 'Analyzing...' : 'AI Auto-Suggest'}</span>
            </button>

            <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-[#f6f6f4] border border-[#e3e3de] text-xs font-mono text-[#141414]">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>Active: {keywords.length} / 10 limit</span>
            </div>
          </div>
        </div>

        {/* AI Suggested Keywords Banner if triggered */}
        {aiSuggestions.length > 0 && keywords.length < 10 && (
          <div className="mt-4 p-4 bg-[#fbfbfa] border border-[#e3e3de] space-y-2 animate-in fade-in duration-200">
            <span className="text-[11px] font-mono text-[#141414] font-semibold flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-emerald-600" />
              AI Suggestions from: "{profile?.core_offer?.slice(0, 45) || 'Your Company Profile'}..."
            </span>
            <div className="flex flex-wrap gap-2">
              {aiSuggestions
                .filter((s) => !keywords.some((k) => k.keyword.toLowerCase() === s.toLowerCase()))
                .map((sug) => (
                  <button
                    key={sug}
                    onClick={() => handleAdd(sug)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-mono bg-white hover:bg-[#141414] hover:text-white border border-[#deded8] rounded-full transition-colors cursor-pointer group"
                  >
                    <Plus className="w-2.5 h-2.5 text-[#8a8a86] group-hover:text-white" />
                    <span>{sug}</span>
                  </button>
                ))}
            </div>
          </div>
        )}

        {/* Pill Input Management */}
        <div className="pt-6">
          <label className="text-xs font-mono uppercase tracking-wider text-[#4a4a47] block mb-2">
            Keywords & phrases
          </label>
          <PillInput
            keywords={keywords.map((k) => k.keyword)}
            onAdd={handleAdd}
            onRemove={handleRemove}
            max={10}
            placeholder="Type keyword and press Enter or comma..."
            showSuggestions={true}
          />
        </div>
      </div>

      {/* Sweep Schedule & Coverage Notice */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-[#ffffff] border border-[#e3e3de] p-5 space-y-2">
          <div className="flex items-center gap-2 text-xs font-mono text-[#141414] font-semibold">
            <Zap className="w-3.5 h-3.5" />
            <span>Automated Sweep Policy</span>
          </div>
          <p className="text-xs text-[#8a8a86] font-mono leading-relaxed">
            Every day at <span className="text-[#141414] font-medium">{sweepTime} UTC</span>, Echo scans connected social platforms for conversations from the last <span className="text-[#141414] font-medium">{lookbackHours} hours</span> matching each active keyword. Results are automatically deduplicated and verified.
          </p>
        </div>

        <div className="bg-[#ffffff] border border-[#e3e3de] p-5 space-y-2">
          <div className="flex items-center gap-2 text-xs font-mono text-[#141414] font-semibold">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Data Integrity</span>
          </div>
          <p className="text-xs text-[#8a8a86] font-mono leading-relaxed">
            Deleting a keyword will remove it from future daily sweeps. Historical posts that previously matched this keyword are preserved in your feed.
          </p>
        </div>
      </div>
    </div>
  );
};

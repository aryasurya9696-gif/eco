import React, { useState } from 'react';
import { useEcho } from '../../context/EchoContext';
import { useAuth } from '../../context/AuthContext';
import { PillInput } from '../common/PillInput';
import type { KeywordSuggestion, KeywordSuggestionResult } from '../../lib/ai';
import {
  ShieldCheck, Zap, Sparkles, Plus, AlertTriangle, Users, Check,
} from 'lucide-react';

const CHANNEL_LABEL: Record<string, string> = {
  x: 'X',
  reddit: 'Reddit',
  web: 'Web',
  news: 'News',
};

const INTENT_STYLE: Record<KeywordSuggestion['intent'], string> = {
  high: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  low: 'bg-[#f6f6f4] text-[#8a8a86] border-[#e3e3de]',
};

export const KeywordsTab: React.FC = () => {
  const { keywords, keywordLimit, addKeyword, removeKeyword, suggestKeywordsFromOffer, addToast, sweepTime, lookbackHours, enabledChannels } = useEcho();
  const { profile } = useAuth();
  const [aiResult, setAiResult] = useState<KeywordSuggestionResult | null>(null);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [addedPhrases, setAddedPhrases] = useState<Set<string>>(new Set());

  const remaining = Math.max(0, keywordLimit - keywords.length);

  const handleAdd = async (keyword: string) => {
    await addKeyword(keyword);
  };

  const handleRemove = async (keywordText: string) => {
    const target = keywords.find((k) => k.keyword.toLowerCase() === keywordText.toLowerCase());
    if (target) {
      await removeKeyword(target.id);
    }
  };

  const handleGenerateAiKeywords = async () => {
    if (remaining === 0) {
      addToast('Keyword limit reached. Remove one before generating more.', 'error');
      return;
    }
    setIsGenerating(true);
    try {
      const result = await suggestKeywordsFromOffer(profile?.core_offer || '', profile?.website || '');
      setAiResult(result);
      setAddedPhrases(new Set());
      if (result.source === 'fallback') {
        addToast('AI key not configured — showing heuristic suggestions.', 'info');
      } else {
        addToast(`AI generated ${result.suggestions.length} keyword suggestions.`, 'success');
      }
    } catch (err: any) {
      addToast(`AI generation error: ${err?.message || 'Failed to suggest keywords'}`, 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAddSuggestion = async (s: KeywordSuggestion) => {
    if (remaining === 0) return;
    await handleAdd(s.phrase);
    setAddedPhrases((prev) => new Set(prev).add(s.phrase));
  };

  const channelLabel = (c: string) =>
    c === 'twitter' ? 'X' : c === 'google' ? 'Web' : c.charAt(0).toUpperCase() + c.slice(1);

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
              Scanned daily across {enabledChannels.length} active channels ({enabledChannels.map(channelLabel).join(', ')}) for buyer-intent mentions.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleGenerateAiKeywords}
              disabled={isGenerating || remaining === 0}
              title={remaining === 0 ? 'Remove a keyword to free up a slot' : undefined}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#f6f6f4] hover:bg-[#ecece7] border border-[#e3e3de] text-xs font-mono text-[#141414] transition-colors cursor-pointer disabled:opacity-40"
            >
              <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
              <span>{isGenerating ? 'Analyzing...' : 'AI Auto-Suggest'}</span>
            </button>

            <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-[#f6f6f4] border border-[#e3e3de] text-xs font-mono text-[#141414]">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>Active: {keywords.length} / {keywordLimit} limit</span>
            </div>
          </div>
        </div>

        {/* AI suggestions */}
        {aiResult && aiResult.suggestions.length > 0 && (
          <div className="mt-4 border border-[#e3e3de] bg-[#fbfbfa] animate-in fade-in duration-200">
            <div className="px-4 py-3 border-b border-[#eeeeea] space-y-1.5">
              <span className="text-[11px] font-mono text-[#141414] font-semibold flex items-center gap-1.5">
                <Sparkles className="w-3 h-3 text-emerald-600" />
                Ranked by expected lead value
              </span>
              {aiResult.icp && (
                <p className="text-[11px] font-mono text-[#4a4a47] flex items-start gap-1.5 leading-relaxed">
                  <Users className="w-3 h-3 mt-px flex-shrink-0 text-[#8a8a86]" />
                  <span><span className="text-[#8a8a86]">Detected buyer —</span> {aiResult.icp}</span>
                </p>
              )}
              {aiResult.avoid.length > 0 && (
                <p className="text-[11px] font-mono text-[#8a8a86] flex items-start gap-1.5 leading-relaxed">
                  <AlertTriangle className="w-3 h-3 mt-px flex-shrink-0 text-amber-600" />
                  <span>
                    <span className="text-amber-700">Would pull in noise —</span>{' '}
                    {aiResult.avoid.join(', ')}
                  </span>
                </p>
              )}
            </div>

            <div className="divide-y divide-[#eeeeea]">
              {aiResult.suggestions.map((s) => {
                const alreadyTracked = keywords.some(
                  (k) => k.keyword.toLowerCase() === s.phrase.toLowerCase(),
                );
                const justAdded = addedPhrases.has(s.phrase) || alreadyTracked;
                const full = remaining === 0;

                return (
                  <div
                    key={s.phrase}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-white transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-mono text-[#141414] font-medium">
                          {s.phrase}
                        </span>
                        <span className={`px-1.5 py-px text-[9px] font-mono uppercase border ${INTENT_STYLE[s.intent]}`}>
                          {s.intent}
                        </span>
                        {s.score > 0 && (
                          <span className="text-[10px] font-mono text-[#a8a8a2]">
                            {s.score}/97
                          </span>
                        )}
                        {s.channels.map((c) => (
                          <span key={c} className="text-[10px] font-mono text-[#8a8a86]">
                            {CHANNEL_LABEL[c] ?? c}
                          </span>
                        ))}
                      </div>
                      {s.why && (
                        <p className="text-[11px] font-mono text-[#8a8a86] mt-0.5 leading-relaxed">
                          {s.why}
                        </p>
                      )}
                    </div>

                    <button
                      onClick={() => void handleAddSuggestion(s)}
                      disabled={justAdded || full}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-mono bg-white hover:bg-[#141414] hover:text-white border border-[#deded8] rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:text-[#141414] flex-shrink-0"
                    >
                      {justAdded ? (
                        <>
                          <Check className="w-2.5 h-2.5 text-emerald-600" />
                          <span>Tracked</span>
                        </>
                      ) : (
                        <>
                          <Plus className="w-2.5 h-2.5 text-[#8a8a86]" />
                          <span>Add</span>
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
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
            max={keywordLimit}
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
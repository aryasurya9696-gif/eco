import React, { useState, type KeyboardEvent } from 'react';
import { X, Plus } from 'lucide-react';

interface PillInputProps {
  keywords: string[];
  onAdd: (keyword: string) => void;
  onRemove: (keyword: string) => void;
  max?: number;
  placeholder?: string;
  disabled?: boolean;
  suggestions?: string[];
  showSuggestions?: boolean;
}

export const PillInput: React.FC<PillInputProps> = ({
  keywords,
  onAdd,
  onRemove,
  max = 10,
  placeholder = 'Add a keyword (e.g. "ai agents", "b2b sales")...',
  disabled = false,
  suggestions = [
    'ai agents',
    'b2b sales',
    'competitor name',
    'outbound pipeline',
    'lead qualification',
    'social listening',
  ],
  showSuggestions = true,
}) => {
  const [inputValue, setInputValue] = useState('');
  const isAtLimit = keywords.length >= max;

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitCurrent();
    }
  };

  const commitCurrent = () => {
    const trimmed = inputValue.trim().replace(/^,+|,+$/g, '');
    if (!trimmed) return;
    if (isAtLimit) return;
    
    // Check if already in list
    if (!keywords.some((k) => k.toLowerCase() === trimmed.toLowerCase())) {
      onAdd(trimmed);
      setInputValue('');
    } else {
      setInputValue('');
    }
  };

  const handleAddSuggestion = (suggestion: string) => {
    if (isAtLimit) return;
    if (!keywords.some((k) => k.toLowerCase() === suggestion.toLowerCase())) {
      onAdd(suggestion);
    }
  };

  return (
    <div className="w-full space-y-3">
      {/* Pills container */}
      <div className="flex flex-wrap items-center gap-2 min-h-[38px] p-2 bg-[#ffffff] border border-[#e3e3de] rounded-none focus-within:border-[#141414] transition-colors">
        {keywords.map((kw) => (
          <span
            key={kw}
            className="inline-flex items-center gap-1.5 px-3 py-1 bg-[#eeeeea] text-[#141414] text-xs font-medium rounded-full border border-[#deded8] animate-in fade-in duration-150"
          >
            <span>{kw}</span>
            <button
              type="button"
              onClick={() => onRemove(kw)}
              disabled={disabled}
              className="text-[#8a8a86] hover:text-[#141414] transition-colors focus:outline-none cursor-pointer"
              aria-label={`Remove ${kw}`}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}

        {/* Input */}
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commitCurrent}
          placeholder={keywords.length === 0 ? placeholder : isAtLimit ? '' : 'Add another...'}
          disabled={disabled || isAtLimit}
          className={`flex-1 min-w-[140px] bg-transparent text-sm text-[#141414] placeholder:text-[#9b9b96] focus:outline-none px-1 py-0.5 ${
            isAtLimit ? 'cursor-not-allowed opacity-40' : ''
          }`}
        />

        {/* Counter */}
        <div className="ml-auto pl-2 text-xs font-mono text-[#8a8a86] whitespace-nowrap self-center">
          <span className={keywords.length === max ? 'text-[#141414] font-semibold' : ''}>
            {keywords.length}
          </span>
          <span className="text-[#9b9b96]"> / {max}</span>
        </div>
      </div>

      {/* Limit warning */}
      {isAtLimit && (
        <p className="text-xs text-[#8a8a86] font-mono tracking-tight">
          {/* From the prop rather than a literal. This component is rendered with
              a max of 8 elsewhere, so a hardcoded 10 here told people the limit
              was ten while the database quietly refused the ninth. */}
          You&apos;ve reached the {max} keyword limit — remove one to add another.
        </p>
      )}

      {/* Clickable suggestion chips */}
      {showSuggestions && !isAtLimit && (
        <div className="space-y-1.5 pt-1">
          <span className="text-[11px] uppercase tracking-wider font-mono text-[#8a8a86] block">
            Suggested ideas:
          </span>
          <div className="flex flex-wrap gap-1.5">
            {suggestions
              .filter((s) => !keywords.some((k) => k.toLowerCase() === s.toLowerCase()))
              .slice(0, 6)
              .map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => handleAddSuggestion(suggestion)}
                  disabled={isAtLimit}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-[#4a4a47] bg-[#f6f6f4] hover:bg-[#ecece7] border border-[#e3e3de] rounded-full transition-colors cursor-pointer group"
                >
                  <Plus className="w-2.5 h-2.5 text-[#8a8a86] group-hover:text-[#141414]" />
                  <span>{suggestion}</span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
};

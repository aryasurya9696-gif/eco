import React from 'react';
import { Plus, X } from 'lucide-react';

/**
 * An editable row of tags — industries, countries, job titles, exclusions.
 *
 * The whole point of the ICP card is that the user can correct it, so every chip
 * has a remove control and the field accepts both Enter and comma, because people
 * type "Accounting, Bookkeeping" as one entry and a form that splits that into
 * two rows of their own making is a form they stop trusting.
 *
 * Removable chips show their X on hover rather than always, because a permanent
 * cross on every chip turns the row into a wall of controls and the values are
 * what is being read.
 */
export const ChipRow: React.FC<{
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  /** Offered when the row is empty, as one-click additions. */
  suggestions?: string[];
  placeholder?: string;
  /** Industries map through a provider's own vocabulary; some do not. */
  mapped?: boolean;
  disabled?: boolean;
  /**
   * A visible, bordered input with its placeholder always shown. For filter
   * panels, where an empty row with no box reads as nothing being there to fill.
   */
  boxed?: boolean;
}> = ({ label, values, onChange, suggestions = [], placeholder = 'Add…', mapped = true, disabled = false, boxed = false }) => {
  const [draft, setDraft] = React.useState('');

  const commit = (raw: string) => {
    const value = raw.trim().replace(/,$/, '');
    if (!value) return;
    // Case-insensitive dedupe: "Accounting" and "accounting" are the same
    // filter value, and sending both narrows the search for no reason.
    if (values.some((v) => v.toLowerCase() === value.toLowerCase())) {
      setDraft('');
      return;
    }
    onChange([...values, value]);
    setDraft('');
  };

  const remove = (v: string) => onChange(values.filter((x) => x !== v));

  return (
    <div className="group/row">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86]">
          {label}
        </span>
        {!mapped && (
          <span
            className="text-[9px] font-mono text-[#b5801f]"
            title="This provider has no value for one of these, so it is being matched by keyword instead. The search will be a little broader."
          >
            matched by keyword
          </span>
        )}
      </div>

      <div className={`flex flex-wrap items-center gap-1.5 ${boxed ? 'border border-[#e3e3de] px-1.5 py-1 focus-within:ring-1 focus-within:ring-[#141414]' : ''}`}>
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#f0f0ec] text-[10px] font-mono text-[#4a4a47] rounded-none"
          >
            {v}
            {!disabled && (
              <button
                onClick={() => remove(v)}
                className="text-[#b5b5ad] hover:text-[#c0462e] transition-colors cursor-pointer"
                aria-label={`Remove ${v}`}
              >
                <X className="w-2.5 h-2.5" />
              </button>
            )}
          </span>
        ))}

        {!disabled && (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                // Comma is a separator here, not punctuation to keep.
                e.preventDefault();
                commit(draft);
              } else if (e.key === 'Backspace' && draft === '' && values.length) {
                remove(values[values.length - 1]);
              }
            }}
            onBlur={() => commit(draft)}
            placeholder={values.length === 0 && (suggestions.length || boxed) ? placeholder : ''}
            aria-label={label}
            className="min-w-[6rem] flex-1 bg-transparent text-[10px] font-mono text-[#141414] placeholder:text-[#b5b5ad] focus:outline-none py-0.5"
          />
        )}

        {values.length === 0 && suggestions.length > 0 && !disabled && (
          <div className="flex flex-wrap gap-1.5 w-full mt-1.5">
            {suggestions.slice(0, 6).map((s) => (
              <button
                key={s}
                onClick={() => commit(s)}
                className="inline-flex items-center gap-1 px-2 py-0.5 border border-[#e3e3de] text-[10px] font-mono text-[#8a8a86] hover:border-[#141414] hover:text-[#141414] transition-colors cursor-pointer rounded-none"
              >
                <Plus className="w-2.5 h-2.5" />
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * A single-choice group of chips, for regions and sizes.
 *
 * Single choice rather than multi, because asking for UK and Australia and
 * India and the EU at once is a search broad enough that the free count comes
 * back in the millions and the estimate stops being meaningful.
 */
export const ChipChoice: React.FC<{
  label: string;
  options: string[];
  value: string | null;
  onChange: (v: string) => void;
}> = ({ label, options, value, onChange }) => (
  <div>
    <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] block mb-1.5">
      {label}
    </span>
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`px-2 py-0.5 text-[10px] font-mono rounded-none transition-colors cursor-pointer ${
            value === o
              ? 'bg-[#141414] text-white'
              : 'border border-[#e3e3de] text-[#8a8a86] hover:border-[#141414] hover:text-[#141414]'
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  </div>
);

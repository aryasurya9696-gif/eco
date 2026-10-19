import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Check, X, Search } from 'lucide-react';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Secondary text shown after the label (a region, an ISO code). */
  hint?: string;
  /** Leading glyph, such as a flag. */
  icon?: React.ReactNode;
  /** Extra text matched by the search box but not displayed. */
  keywords?: string;
  group?: string;
}

interface ComboboxProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder: string;
  searchPlaceholder: string;
  /** Icon shown in the trigger when nothing is selected. */
  emptyIcon?: React.ReactNode;
  /** Label of the "no filter" option, e.g. "Any country". */
  anyLabel: string;
  /** Lets the user commit whatever they typed (free-text locations). */
  allowCustom?: boolean;
  disabled?: boolean;
  /** Shown under the options when the search matches nothing. */
  emptyText?: string;
  'aria-labelledby'?: string;
}

/**
 * A searchable single-select.
 *
 * The previous country and city dropdowns were mouse-only: no arrow keys, no
 * Escape, the clear "button" was a span nested inside the trigger button (so
 * it could not be focused, and clicking it also toggled the menu), and nothing
 * told a screen reader that a list had opened.
 */
export const Combobox: React.FC<ComboboxProps> = ({
  id,
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyIcon,
  anyLabel,
  allowCustom = false,
  disabled = false,
  emptyText = 'No matches',
  'aria-labelledby': labelledBy,
}) => {
  const autoId = useId();
  const baseId = id ?? autoId;
  const listId = `${baseId}-list`;
  const [isOpen, setIsOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value.toLowerCase() === value.toLowerCase());

  const filtered = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      `${o.label} ${o.hint ?? ''} ${o.value} ${o.keywords ?? ''}`.toLowerCase().includes(q),
    );
  }, [options, term]);

  const customValue = term.trim();
  const showCustom =
    allowCustom && customValue !== '' && !filtered.some((o) => o.label.toLowerCase() === customValue.toLowerCase());

  // Row model: "any" first, then the matches, then the free-text entry.
  type Row = { kind: 'any' } | { kind: 'option'; option: ComboboxOption } | { kind: 'custom'; value: string };
  const rows: Row[] = useMemo(() => {
    const r: Row[] = [];
    if (!term.trim()) r.push({ kind: 'any' });
    filtered.forEach((option) => r.push({ kind: 'option', option }));
    if (showCustom) r.push({ kind: 'custom', value: customValue });
    return r;
  }, [filtered, showCustom, customValue, term]);

  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    inputRef.current?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [isOpen]);

  // The highlighted row, kept in range as the filter shrinks the list.
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1));
  useEffect(() => {
    if (!isOpen) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, isOpen]);

  const open = () => {
    if (disabled) return;
    setTerm('');
    const idx = selected ? options.indexOf(selected) + 1 : 0;
    setActive(Math.max(0, idx));
    setIsOpen(true);
  };

  function close(returnFocus = true) {
    setIsOpen(false);
    setTerm('');
    if (returnFocus) triggerRef.current?.focus();
  }

  const commit = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === 'any') onChange('');
    else if (row.kind === 'option') onChange(row.option.value);
    else onChange(row.value);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive(Math.min(rows.length - 1, activeIndex + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive(Math.max(0, activeIndex - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(rows.length - 1);
        break;
      case 'Enter':
        // Never let Enter inside the menu submit the surrounding search form.
        e.preventDefault();
        commit(rows[activeIndex]);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case 'Tab':
        close(false);
        break;
    }
  };

  const optionId = (i: number) => `${baseId}-opt-${i}`;
  let lastGroup: string | undefined;

  return (
    <div ref={rootRef} className="relative w-full">
      <div className="relative">
        <button
          ref={triggerRef}
          id={baseId}
          type="button"
          disabled={disabled}
          onClick={() => (isOpen ? close() : open())}
          onKeyDown={(e) => {
            if (!isOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              open();
            }
          }}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls={isOpen ? listId : undefined}
          aria-labelledby={labelledBy ? `${labelledBy} ${baseId}` : undefined}
          className={`w-full h-10 pl-3 ${selected || (allowCustom && value) ? 'pr-16' : 'pr-9'} bg-white border text-sm text-left flex items-center gap-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:border-ink focus-visible:ring-2 focus-visible:ring-ink/10 ${
            isOpen ? 'border-ink' : 'border-line hover:border-line-strong'
          }`}
        >
          {selected ? (
            <>
              {selected.icon && <span className="shrink-0" aria-hidden>{selected.icon}</span>}
              <span className="truncate text-ink">{selected.label}</span>
              {selected.hint && <span className="shrink-0 text-xs text-muted">{selected.hint}</span>}
            </>
          ) : allowCustom && value ? (
            <>
              {emptyIcon && <span className="shrink-0 text-muted" aria-hidden>{emptyIcon}</span>}
              <span className="truncate text-ink">{value}</span>
            </>
          ) : (
            <>
              {emptyIcon && <span className="shrink-0 text-muted" aria-hidden>{emptyIcon}</span>}
              <span className="truncate text-muted">{placeholder}</span>
            </>
          )}
        </button>

        {/* Siblings of the trigger, not children: a button nested in a
            button cannot be focused and its click also toggled the menu. */}
        <div className="absolute inset-y-0 right-2 flex items-center gap-0.5 pointer-events-none">
          {(selected || (allowCustom && value)) && !disabled && (
            <button
              type="button"
              onClick={() => {
                onChange('');
                triggerRef.current?.focus();
              }}
              className="pointer-events-auto p-1 text-muted hover:text-ink hover:bg-fill cursor-pointer focus-visible:outline-2 focus-visible:outline-ink"
              aria-label={`Clear ${anyLabel.replace(/^Any /i, '')}`}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <ChevronDown
            className={`w-4 h-4 text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`}
            aria-hidden
          />
        </div>
      </div>

      {isOpen && (
        <div className="absolute z-40 left-0 right-0 min-w-[240px] mt-1 bg-white border border-line-strong shadow-lg flex flex-col">
          <div className="p-2 border-b border-line-soft flex items-center gap-2">
            <Search className="w-4 h-4 text-muted shrink-0" aria-hidden />
            <input
              ref={inputRef}
              type="text"
              value={term}
              onChange={(e) => {
                setTerm(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={rows.length ? optionId(activeIndex) : undefined}
              aria-label={searchPlaceholder}
              className="w-full h-8 bg-transparent text-sm text-ink placeholder:text-muted outline-none"
            />
          </div>

          <ul ref={listRef} id={listId} role="listbox" className="overflow-y-auto max-h-64 py-1 text-sm">
            {rows.map((row, i) => {
              const isActive = i === activeIndex;
              const base = `w-full px-3 py-2 flex items-center gap-2 cursor-pointer ${isActive ? 'bg-fill' : ''}`;

              if (row.kind === 'any') {
                return (
                  <li
                    key="__any"
                    id={optionId(i)}
                    data-index={i}
                    role="option"
                    aria-selected={!value}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => commit(row)}
                    className={`${base} border-b border-line-soft text-ink-2`}
                  >
                    <span className="flex-1">{anyLabel}</span>
                    {!value && <Check className="w-4 h-4 text-ink" aria-hidden />}
                  </li>
                );
              }

              if (row.kind === 'custom') {
                return (
                  <li
                    key="__custom"
                    id={optionId(i)}
                    data-index={i}
                    role="option"
                    aria-selected={false}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => commit(row)}
                    className={`${base} border-t border-line-soft`}
                  >
                    <span className="text-muted">Use</span>
                    <span className="font-medium text-ink truncate">“{row.value}”</span>
                    <kbd className="ml-auto text-[11px] text-muted border border-line px-1">Enter</kbd>
                  </li>
                );
              }

              const { option } = row;
              const isSelected = option.value.toLowerCase() === value.toLowerCase();
              const header =
                option.group && option.group !== lastGroup && !term.trim() ? option.group : null;
              lastGroup = option.group;
              return (
                <React.Fragment key={option.value}>
                  {header && (
                    <li role="presentation" className="px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
                      {header}
                    </li>
                  )}
                  <li
                    id={optionId(i)}
                    data-index={i}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => commit(row)}
                    className={`${base} ${isSelected ? 'font-medium text-ink' : 'text-ink-2'}`}
                  >
                    {option.icon && <span className="shrink-0" aria-hidden>{option.icon}</span>}
                    <span className="truncate">{option.label}</span>
                    {option.hint && <span className="shrink-0 text-xs text-muted">{option.hint}</span>}
                    {isSelected && <Check className="w-4 h-4 text-ink ml-auto shrink-0" aria-hidden />}
                  </li>
                </React.Fragment>
              );
            })}
            {rows.length === 0 && <li className="px-3 py-3 text-center text-muted">{emptyText}</li>}
          </ul>
        </div>
      )}
    </div>
  );
};

import React, { useEffect, useId, useRef, useState } from 'react';
import {
  Search,
  Briefcase,
  Tag,
  Building2,
  Globe,
  Users,
  Mail,
  Phone,
  ChevronDown,
  X,
  Sparkles,
  Loader2,
  Clock,
  Check,
  Plus,
  AlertCircle,
  Info,
  Lock,
} from 'lucide-react';
import { CitySelect } from './CitySelect';
import { CountrySelect } from './CountrySelect';
import { countryByCode } from './countries';
import { suggestRoles, relatedRoles, suggestKeywords } from '../../lib/lead-suggestions';
import { parseLeadQuery } from '../../lib/ai';
import {
  QUANTITY_OPTIONS,
  MAX_LIMIT,
  MIN_LIMIT,
  sanitizeLimit,
  searchCost,
  searchFeeText,
  domainCountOf,
  hasCriteria,
  maxContactCost,
  type LeadPricing,
  type ProspectorSearchParams,
  type SearchForm,
} from './prospector-types';
import { describeSearch } from './recent-searches';
import { creditsLabel, formatCredits } from '../../lib/billing';

interface SearchBarProps {
  form: SearchForm;
  onChange: (next: SearchForm) => void;
  onSubmit: () => void;
  isSearching: boolean;
  pricing: LeadPricing;
  availableCredits: number | null;
  recent: ProspectorSearchParams[];
  onPickRecent: (p: ProspectorSearchParams) => void;
  /** Shown under the bar: validation, "filters changed", balance notes. */
  notice?: { tone: 'error' | 'info' | 'warn'; text: string } | null;
  onNavigateBilling?: () => void;
}

// ---------------------------------------------------------------------------
// Popover chip
// ---------------------------------------------------------------------------

const Chip: React.FC<{
  icon: React.ReactNode;
  label: string;
  value?: string;
  onClear?: () => void;
  disabled?: boolean;
  children: (close: () => void) => React.ReactNode;
  wide?: boolean;
}> = ({ icon, label, value, onClear, disabled, children, wide }) => {
  const [open, setOpen] = useState(false);
  // Horizontal shift that keeps the panel inside the viewport, so a chip near
  // either edge of a phone screen never pushes its panel off-screen.
  const [offset, setOffset] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const toggle = () => {
    if (!open && ref.current) {
      const left = ref.current.getBoundingClientRect().left;
      const width = Math.min(window.innerWidth * 0.92, wide ? 380 : 300);
      setOffset(Math.max(8 - left, Math.min(0, window.innerWidth - 8 - left - width)));
    }
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Dark = an active filter the user can remove; light = a setting that
  // always has a value (lead count, contacts), so it never looks like a filter.
  const filled = Boolean(value) && Boolean(onClear);
  const setting = Boolean(value) && !onClear;
  return (
    <div ref={ref} className="relative">
      <div
        className={`h-9 inline-flex items-center border text-[13px] transition-colors ${
          filled
            ? 'bg-ink text-white border-ink'
            : setting
              ? 'bg-surface-2 text-ink border-line-strong hover:border-ink'
              : 'bg-white text-ink-2 border-line hover:border-line-strong hover:text-ink'
        } ${disabled ? 'opacity-50' : ''}`}
      >
        <button
          type="button"
          disabled={disabled}
          onClick={toggle}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          className="h-full pl-3 pr-2 inline-flex items-center gap-1.5 cursor-pointer disabled:cursor-not-allowed max-w-[260px]"
        >
          <span className={filled ? 'text-white/70' : 'text-muted'} aria-hidden>
            {icon}
          </span>
          <span className={filled ? 'text-white/70' : ''}>{label}</span>
          {(filled || setting) && <span className="font-medium truncate">{value}</span>}
          {!filled && !setting && <Plus className="w-3.5 h-3.5 text-muted" aria-hidden />}
          {setting && <ChevronDown className="w-3.5 h-3.5 text-muted" aria-hidden />}
        </button>
        {filled && onClear && (
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            className="h-full px-2 border-l border-white/20 hover:bg-white/10 cursor-pointer"
            aria-label={`Remove ${label.toLowerCase()} filter`}
          >
            <X className="w-3.5 h-3.5" aria-hidden />
          </button>
        )}
      </div>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={label}
          style={{ left: offset }}
          className={`absolute z-40 mt-1.5 bg-white border border-line-strong shadow-xl p-3 ${wide ? 'w-[min(92vw,380px)]' : 'w-[min(92vw,300px)]'}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Role input with autocomplete
// ---------------------------------------------------------------------------

const RoleInput: React.FC<{ value: string; onChange: (v: string) => void; disabled?: boolean }> = ({
  value,
  onChange,
  disabled,
}) => {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const suggestions = suggestRoles(value);
  const exact = suggestions.some((s) => s.title.toLowerCase() === value.trim().toLowerCase());
  const show = open && !disabled && suggestions.length > 0 && !(exact && suggestions.length === 1);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const pick = (title: string) => {
    onChange(title);
    setOpen(false);
    setActive(-1);
  };

  return (
    <div ref={wrapRef} className="relative flex-1 min-w-0">
      <label htmlFor={`${listId}-input`} className="sr-only">
        Job title or role
      </label>
      <Briefcase className="w-5 h-5 text-muted absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
      <input
        id={`${listId}-input`}
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        // Options use onMouseDown + preventDefault, so picking one never blurs
        // first; any other blur (Tab, clicking Search) closes the list.
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!show) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => Math.min(suggestions.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(-1, i - 1));
          } else if (e.key === 'Enter' && active >= 0) {
            // Enter picks the highlighted role; with nothing highlighted it
            // falls through and submits the search.
            e.preventDefault();
            pick(suggestions[active].title);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        placeholder="Job title, e.g. Founder, VP Sales, CTO"
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={show}
        aria-controls={show ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={show && active >= 0 ? `${listId}-${active}` : undefined}
        maxLength={200}
        className="w-full h-14 pl-12 pr-10 bg-white border-0 text-base text-ink placeholder:text-muted outline-none disabled:opacity-50"
      />
      {value && !disabled && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-ink hover:bg-fill cursor-pointer"
          aria-label="Clear job title"
        >
          <X className="w-4 h-4" aria-hidden />
        </button>
      )}
      {show && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-40 left-0 right-0 top-full mt-px bg-white border border-line-strong shadow-xl py-1 max-h-80 overflow-y-auto"
        >
          {!value.trim() && <li className="px-4 pt-1.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Popular roles</li>}
          {suggestions.map((s, i) => (
            <li
              key={s.title}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(s.title)}
              className={`px-4 py-2 flex items-center justify-between gap-3 cursor-pointer text-sm ${i === active ? 'bg-fill' : ''}`}
            >
              <span className="text-ink">{s.title}</span>
              <span className="text-xs text-muted">{s.group}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Search bar
// ---------------------------------------------------------------------------

export const SearchBar: React.FC<SearchBarProps> = ({
  form,
  onChange,
  onSubmit,
  isSearching,
  pricing,
  availableCredits,
  recent,
  onPickRecent,
  notice,
  onNavigateBilling,
}) => {
  const ids = useId();
  const set = <K extends keyof SearchForm>(key: K, value: SearchForm[K]) => onChange({ ...form, [key]: value });
  const [keywordDraft, setKeywordDraft] = useState('');
  const [limitDraft, setLimitDraft] = useState('');
  const [aiOpen, setAiOpen] = useState(false);
  const [aiText, setAiText] = useState('');
  const [aiState, setAiState] = useState<{ kind: 'idle' | 'loading' | 'done' | 'error'; note?: string }>({ kind: 'idle' });

  // Most this search can cost: every lead verified for each detail switched
  // on. Charged per verified email / phone actually found, never per lead.
  const domains = domainCountOf(form.companyDomain);
  const maxCost = searchCost(form.limit, pricing, domains) + maxContactCost(form, pricing);
  const costFor = (n: number) => searchCost(n, pricing, domains) + maxContactCost({ ...form, limit: n }, pricing);
  const related = form.title.trim() ? relatedRoles(form.title).filter((r) => r.toLowerCase() !== form.title.trim().toLowerCase()) : [];
  const country = countryByCode(form.country);
  const walletEmpty = availableCredits !== null && availableCredits < Math.max(1, pricing.searchCredits);
  const canSearch = hasCriteria(form) && !isSearching && !walletEmpty && (form.autoEnrich || form.autoPhone);

  const addKeyword = (k: string) => {
    const word = k.trim().slice(0, 60);
    if (!word || form.keywords.some((x) => x.toLowerCase() === word.toLowerCase()) || form.keywords.length >= 10) return;
    set('keywords', [...form.keywords, word]);
    setKeywordDraft('');
  };

  const runAi = async () => {
    const text = aiText.trim();
    if (text.length < 3 || aiState.kind === 'loading') return;
    setAiState({ kind: 'loading' });
    try {
      const { filters, source } = await parseLeadQuery(text);
      const found = filters.title || filters.keywords.length || filters.country || filters.location || filters.company;
      if (!found) {
        setAiState({ kind: 'error', note: 'Could not pick out a role, industry or place. Try “Founders of SaaS companies in London”.' });
        return;
      }
      onChange({
        ...form,
        title: filters.title || form.title,
        keywords: filters.keywords.length ? filters.keywords : form.keywords,
        country: filters.country || form.country,
        location: filters.location || (filters.country && filters.country !== form.country ? '' : form.location),
        companyDomain: filters.company || form.companyDomain,
      });
      setAiState({
        kind: 'done',
        note: source === 'openai' ? 'Filters filled in — check them, then search.' : 'Filters filled in (basic matching) — check them, then search.',
      });
    } catch {
      setAiState({ kind: 'error', note: 'Could not read that description. Please fill the filters manually.' });
    }
  };

  return (
    <section className="bg-white border border-line shadow-[0_1px_2px_rgba(20,20,20,0.04)]" aria-label="Search for leads">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSearch) return;
          // Enter in the role box submits too; drop focus so its list closes.
          (document.activeElement as HTMLElement | null)?.blur?.();
          onSubmit();
        }}
        noValidate
      >
        {/* Main row: role · location · search */}
        <div className="p-2 sm:p-3">
          <div className="flex flex-col md:flex-row md:items-stretch border border-line-strong focus-within:border-ink focus-within:ring-2 focus-within:ring-ink/10 transition-colors">
            <RoleInput value={form.title} onChange={(v) => set('title', v)} disabled={isSearching} />
            <div className="md:w-[300px] lg:w-[340px] border-t md:border-t-0 md:border-l border-line flex items-center [&_button[aria-haspopup]]:h-14 [&_button[aria-haspopup]]:border-0 [&_button[aria-haspopup]]:text-base [&_button[aria-haspopup]]:pl-4">
              <span id={`${ids}-loc`} className="sr-only">
                City, state or region
              </span>
              <CitySelect
                id={`${ids}-city`}
                aria-labelledby={`${ids}-loc`}
                value={form.location}
                onChange={(v) => set('location', v)}
                selectedCountry={form.country}
                disabled={isSearching}
              />
            </div>
            {walletEmpty ? (
              // No credits, no search: there would be nothing to reveal.
              <button
                type="button"
                onClick={onNavigateBilling}
                className="h-14 px-6 md:px-7 bg-ink hover:bg-black text-white font-semibold flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                <Lock className="w-5 h-5" aria-hidden />
                Top up to search
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSearch}
                className="h-14 px-6 md:px-7 bg-ink hover:bg-black text-white font-semibold flex items-center justify-center gap-2 cursor-pointer transition-colors disabled:bg-line-strong disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink whitespace-nowrap"
                title={`Up to ${creditsLabel(maxCost)}: the search (${searchFeeText(pricing)}) plus verified emails and phones found`}
              >
                {isSearching ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden /> : <Search className="w-5 h-5" aria-hidden />}
                <span>{isSearching ? 'Searching…' : 'Find leads'}</span>
                {!isSearching && (
                  <span className="text-[11px] font-medium px-1.5 py-0.5 bg-white/15 tabular-nums">≤ {formatCredits(maxCost)} cr</span>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Filter chips */}
        <div className="px-2 sm:px-3 pb-3 flex flex-wrap items-center gap-2">
          <Chip
            icon={<Tag className="w-3.5 h-3.5" />}
            label="Keywords"
            value={form.keywords.length ? form.keywords.join(', ') : undefined}
            onClear={() => set('keywords', [])}
            disabled={isSearching}
            wide
          >
            {() => (
              <div className="space-y-3">
                <p className="text-xs text-muted">Industry or topic, e.g. SaaS, fintech. Up to 10.</p>
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={keywordDraft}
                    onChange={(e) => setKeywordDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        addKeyword(keywordDraft);
                      }
                    }}
                    placeholder="Type and press Enter"
                    aria-label="Add keyword"
                    className="flex-1 h-9 px-3 bg-white border border-line focus:border-ink outline-none text-sm"
                  />
                  <button type="button" onClick={() => addKeyword(keywordDraft)} className="h-9 px-3 bg-ink text-white text-sm cursor-pointer">
                    Add
                  </button>
                </div>
                {form.keywords.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {form.keywords.map((k) => (
                      <span key={k} className="h-7 pl-2.5 pr-1 inline-flex items-center gap-1 bg-ink text-white text-xs">
                        {k}
                        <button
                          type="button"
                          onClick={() => set('keywords', form.keywords.filter((x) => x !== k))}
                          className="p-0.5 hover:bg-white/15 cursor-pointer"
                          aria-label={`Remove ${k}`}
                        >
                          <X className="w-3 h-3" aria-hidden />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted mb-1.5">Suggestions</p>
                  <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto">
                    {suggestKeywords(keywordDraft, form.keywords, 16).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => addKeyword(k)}
                        className="h-7 px-2.5 text-xs bg-surface-2 border border-line hover:border-ink text-ink-2 hover:text-ink cursor-pointer"
                      >
                        + {k}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </Chip>

          <Chip
            icon={<Building2 className="w-3.5 h-3.5" />}
            label="Company"
            value={form.companyDomain || undefined}
            onClear={() => set('companyDomain', '')}
            disabled={isSearching}
          >
            {(close) => (
              <div className="space-y-2">
                <input
                  autoFocus
                  value={form.companyDomain}
                  onChange={(e) => set('companyDomain', e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      close();
                    }
                  }}
                  placeholder="stripe.com, notion.so"
                  aria-label="Company name or domain"
                  maxLength={1000}
                  className="w-full h-9 px-3 bg-white border border-line focus:border-ink outline-none text-sm"
                />
                <p className="text-xs text-muted">A name or website. Separate several with commas (up to 10).</p>
              </div>
            )}
          </Chip>

          <Chip
            icon={<Globe className="w-3.5 h-3.5" />}
            label="Country"
            value={country ? `${country.flag} ${country.name}` : undefined}
            onClear={() => onChange({ ...form, country: '', location: '' })}
            disabled={isSearching}
            wide
          >
            {(close) => (
              <div className="space-y-2">
                <CountrySelect
                  value={form.country}
                  onChange={(code) => {
                    // A city picked for another country would match nobody.
                    onChange({ ...form, country: code, location: code !== form.country ? '' : form.location });
                    close();
                  }}
                />
                <p className="text-xs text-muted">Changing the country clears the city.</p>
              </div>
            )}
          </Chip>

          <Chip
            icon={<Users className="w-3.5 h-3.5" />}
            label="Leads"
            value={`${form.limit}`}
            disabled={isSearching}
            wide
          >
            {(close) => (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Number of leads">
                  {QUANTITY_OPTIONS.map((n) => {
                    const c = costFor(n);
                    const selected = form.limit === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          set('limit', n);
                          close();
                        }}
                        className={`h-12 border flex flex-col items-center justify-center cursor-pointer ${
                          selected ? 'bg-ink text-white border-ink' : 'bg-white border-line hover:border-ink text-ink'
                        }`}
                      >
                        <span className="text-sm font-semibold tabular-nums">{n}</span>
                        <span className={`text-[11px] ${selected ? 'text-white/70' : 'text-muted'}`}>≤ {c} cr</span>
                      </button>
                    );
                  })}
                </div>
                <label className="flex items-center gap-2 text-[13px] text-ink-2">
                  Custom
                  <input
                    inputMode="numeric"
                    value={limitDraft}
                    onChange={(e) => setLimitDraft(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (limitDraft) set('limit', sanitizeLimit(limitDraft));
                        close();
                      }
                    }}
                    onBlur={() => limitDraft && set('limit', sanitizeLimit(limitDraft))}
                    placeholder={`${MIN_LIMIT}–${MAX_LIMIT}`}
                    className="w-24 h-9 px-2 border border-line focus:border-ink outline-none text-sm text-center tabular-nums"
                  />
                </label>
                <p className="text-xs text-muted">
                  The most it can cost. A search costs {searchFeeText(pricing)}, then {formatCredits(pricing.email)} per verified
                  email and {formatCredits(pricing.phone)} per phone actually found — nothing for leads without them.
                </p>
              </div>
            )}
          </Chip>

          <Chip
            icon={<Mail className="w-3.5 h-3.5" />}
            label="Contacts"
            value={[form.autoEnrich && 'Emails', form.autoPhone && 'Phones'].filter(Boolean).join(' + ') || 'Off'}
            disabled={isSearching}
            wide
          >
            {() => (
              <div className="space-y-2">
                <p className="text-xs text-muted">Looked up automatically after results appear. Charged only when found.</p>
                {(
                  [
                    ['autoEnrich', <Mail key="m" className="w-4 h-4" />, 'Work emails', pricing.email],
                    ['autoPhone', <Phone key="p" className="w-4 h-4" />, 'Direct phone numbers', pricing.phone],
                  ] as const
                ).map(([key, icon, label, price]) => {
                  const checked = form[key];
                  return (
                    <label
                      key={key}
                      className={`flex items-center gap-3 p-2.5 border cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ink/30 ${
                        checked ? 'border-ink' : 'border-line hover:border-line-strong'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        onChange={(e) => {
                          // At least one stays on: a search returns leads by
                          // their verified contacts, so with neither there is
                          // nothing to show.
                          const other = key === 'autoEnrich' ? form.autoPhone : form.autoEnrich;
                          if (!e.target.checked && !other) return;
                          set(key, e.target.checked);
                        }}
                      />
                      <span className={`w-8 h-8 flex items-center justify-center ${checked ? 'bg-ink text-white' : 'bg-fill text-ink-2'}`} aria-hidden>
                        {icon}
                      </span>
                      <span className="flex-1 text-sm text-ink">{label}</span>
                      <span className="text-xs text-muted tabular-nums">{price} cr each</span>
                      <span
                        className={`w-5 h-5 border flex items-center justify-center ${checked ? 'bg-ink border-ink text-white' : 'border-line-strong text-transparent'}`}
                        aria-hidden
                      >
                        <Check className="w-3.5 h-3.5" />
                      </span>
                    </label>
                  );
                })}
                {(form.autoEnrich || form.autoPhone) && (
                  <p className="text-xs text-ink-2">
                    Up to <span className="font-semibold text-ink">{formatCredits(maxCost)}</span> credits for {form.limit} leads,
                    including the search itself ({searchFeeText(pricing)}).
                    {walletEmpty && (
                      <span className="block text-warn">
                        A search costs {searchFeeText(pricing)}. Buy credits to search (welcome credits don't cover leads).
                      </span>
                    )}
                  </p>
                )}
              </div>
            )}
          </Chip>

          <button
            type="button"
            onClick={() => {
              setAiOpen((o) => !o);
              setAiState({ kind: 'idle' });
            }}
            aria-expanded={aiOpen}
            className={`ml-auto h-9 px-3 inline-flex items-center gap-1.5 text-[13px] font-medium border cursor-pointer transition-colors ${
              aiOpen ? 'bg-fill border-ink text-ink' : 'border-transparent text-ink hover:bg-fill'
            }`}
          >
            <Sparkles className="w-4 h-4" aria-hidden />
            Describe your customer
          </button>
        </div>

        {/* AI: describe your customer */}
        {aiOpen && (
          <div className="mx-2 sm:mx-3 mb-3 p-3 bg-surface-2 border border-line">
            <label htmlFor={`${ids}-ai`} className="block text-[13px] font-medium text-ink mb-1.5">
              Describe who you want to reach
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                id={`${ids}-ai`}
                autoFocus
                value={aiText}
                onChange={(e) => setAiText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void runAi();
                  }
                }}
                maxLength={300}
                placeholder="e.g. Founders of SaaS startups in Bangalore"
                className="flex-1 h-10 px-3 bg-white border border-line focus:border-ink outline-none text-sm"
              />
              <button
                type="button"
                onClick={() => void runAi()}
                disabled={aiText.trim().length < 3 || aiState.kind === 'loading'}
                className="h-10 px-4 bg-ink hover:bg-black text-white text-sm font-medium inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {aiState.kind === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Sparkles className="w-4 h-4" aria-hidden />}
                Fill filters
              </button>
            </div>
            {aiState.note && (
              <p className={`mt-2 text-xs ${aiState.kind === 'error' ? 'text-danger' : 'text-ok'}`} role="status">
                {aiState.note}
              </p>
            )}
          </div>
        )}

        {/* Related roles, recent searches, notices */}
        {(related.length > 0 || recent.length > 0 || notice) && (
          <div className="px-3 sm:px-4 py-2.5 border-t border-line-soft bg-surface-2/60 flex flex-col gap-2 text-[13px]">
            {related.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted mr-0.5">Also try:</span>
                {related.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => set('title', r)}
                    disabled={isSearching}
                    className="h-7 px-2.5 bg-white border border-line hover:border-ink text-ink-2 hover:text-ink cursor-pointer disabled:opacity-50"
                  >
                    {r}
                  </button>
                ))}
              </div>
            )}
            {recent.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted mr-0.5 inline-flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" aria-hidden />
                  Recent:
                </span>
                {recent.map((p) => {
                  const label = describeSearch(p, (code) => countryByCode(code)?.name);
                  return (
                    <button
                      key={label + p.limit}
                      type="button"
                      onClick={() => onPickRecent(p)}
                      disabled={isSearching}
                      title={`${label} · ${p.limit} leads`}
                      className="h-7 px-2.5 bg-white border border-line hover:border-ink text-ink-2 hover:text-ink cursor-pointer max-w-[260px] truncate disabled:opacity-50"
                    >
                      {label || 'Search'}
                    </button>
                  );
                })}
              </div>
            )}
            {notice && (
              <p
                className={`flex items-start gap-1.5 ${notice.tone === 'error' ? 'text-danger' : notice.tone === 'warn' ? 'text-warn' : 'text-ink-2'}`}
                aria-live="polite"
              >
                {notice.tone === 'info' ? <Info className="w-4 h-4 shrink-0 mt-px" aria-hidden /> : <AlertCircle className="w-4 h-4 shrink-0 mt-px" aria-hidden />}
                <span>
                  {notice.text}
                  {notice.tone === 'warn' && onNavigateBilling && (
                    <>
                      {' '}
                      <button type="button" onClick={onNavigateBilling} className="underline underline-offset-2 font-medium cursor-pointer">
                        Top up
                      </button>
                    </>
                  )}
                </span>
              </p>
            )}
          </div>
        )}
      </form>
    </section>
  );
};

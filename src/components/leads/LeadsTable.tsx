import React from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  createColumnHelper,
  flexRender,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowUp, ArrowDown, Search, X, Columns3, ShieldOff,
  RefreshCw, Trash2, Loader2, ChevronRight,
} from 'lucide-react';
import type { LeadRow, LeadAttempt } from '../../types';
import { providerStyle } from '../../lib/leads';
import { StatusBadge, CreditsCell } from './StatusBadge';
import { ProviderChip } from './ProviderChip';
import { WaterfallChain } from './WaterfallChain';
import { EmptyState, RowSkeleton } from './Empty';

/**
 * The table people screenshot.
 *
 * Virtualised, so ten thousand rows scroll at the same speed as ten. Nothing
 * here decides anything about a lead — it renders what the worker found and what
 * it cost, and every cell's state is one the database will accept.
 *
 * The columns are accessors rather than display cells, which sounds like a detail
 * and was a real bug: a display column has no value to sort on, so every header
 * button did nothing at all. Sorting by "who found the most" or "what failed"
 * was the most useful thing this table could do and it silently did nothing.
 *
 * Expanding a row draws the waterfall rather than listing it. Three providers
 * tried and the third answered should read as a shape before a single word is
 * read, because "we tried three times and it cost the price of one" is what the
 * shape says and it is the entire argument for having a waterfall at all.
 */

interface LeadsTableProps {
  rows: LeadRow[];
  total: number;
  loading?: boolean;
  attemptsFor?: (rowId: string) => Promise<LeadAttempt[]>;
  onBulk?: (action: 'delete' | 'reverify', rowIds: string[]) => Promise<{ ok: boolean; error?: string }>;
  /** Suppressed on selection, because that is an opt-out not a bulk edit. */
  onSuppress?: (rowIds: string[]) => void;
}

const col = createColumnHelper<LeadRow>();

/** In flight means the waterfall has something to say; done does not. */
const isWorking = (r: LeadRow) => r.state === 'trying' || r.state === 'queued' || r.state === 'miss';

/** Compact is 32px, comfortable 44px. Two numbers, both used elsewhere. */
const ROW_H = { compact: 34, comfortable: 44 } as const;

const ALL_COLUMNS: Array<{ id: string; label: string; always?: boolean }> = [
  { id: 'company', label: 'Company', always: true },
  { id: 'person', label: 'Person' },
  { id: 'email', label: 'Email' },
  { id: 'status', label: 'Status' },
  { id: 'provider', label: 'Found by' },
  { id: 'credits', label: 'Credits' },
  { id: 'title', label: 'Title' },
  { id: 'domain', label: 'Domain' },
];

export const LeadsTable: React.FC<LeadsTableProps> = ({
  rows,
  total,
  loading = false,
  attemptsFor,
  onBulk,
  onSuppress,
}) => {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [query, setQuery] = React.useState('');
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [attempts, setAttempts] = React.useState<Record<string, LeadAttempt[]>>({});
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());
  const [dense, setDense] = React.useState(false);
  const [showCols, setShowCols] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const rowH = dense ? ROW_H.compact : ROW_H.comfortable;

  // accessors, not display cells — see the header comment. The accessor is what
  // sorting reads and what the search box filters against.
  // No explicit type on the array. TanStack's ColumnDef is invariant in its value
  // type, so annotating it `unknown` turns every accessor's cell function into a
  // type error — the annotation has to be as wide as the widest accessor, which
  // is exactly the thing the compiler would rather work out for itself.
  const columns = React.useMemo(
    () => [
      col.accessor('company_name', {
        id: 'company',
        header: 'Company',
        cell: (info) => {
          const r = info.row.original;
          return (
            <div className="flex items-center gap-2 min-w-0">
              {r.logo_url ? (
                <img
                  src={r.logo_url}
                  alt=""
                  className="w-4 h-4 object-contain flex-shrink-0"
                  // A provider logo that 404s should leave a gap, not put a broken
                  // image icon in every row that has one.
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.visibility = 'hidden';
                  }}
                />
              ) : (
                <div className="w-4 h-4 bg-[#f0f0ec] flex-shrink-0" aria-hidden="true" />
              )}
              <span className="text-[11px] text-[#141414] truncate">
                {r.company_name || r.domain || '—'}
              </span>
            </div>
          );
        },
      }),

      col.accessor('person_name', {
        id: 'person',
        header: 'Person',
        cell: (info) => {
          const r = info.row.original;
          if (!r.person_name) return <Dash />;
          return <span className="text-[11px] text-[#141414] truncate">{r.person_name}</span>;
        },
      }),

      col.accessor('title', {
        id: 'title',
        header: 'Title',
        cell: (info) => {
          const v = info.getValue();
          return v ? (
            <span className="text-[10px] font-mono text-[#8a8a86] truncate">{v}</span>
          ) : (
            <Dash />
          );
        },
      }),

      col.accessor('domain', {
        id: 'domain',
        header: 'Domain',
        cell: (info) => {
          const v = info.getValue();
          return v ? (
            <span className="text-[10px] font-mono text-[#8a8a86] truncate">{v}</span>
          ) : (
            <Dash />
          );
        },
      }),

      col.accessor('email', {
        id: 'email',
        header: 'Email',
        cell: (info) => {
          const r = info.row.original;
          if (isWorking(r) && !r.email) {
            return <Working provider={r.current_provider} />;
          }
          if (!r.email) return <Dash />;
          return (
            <a
              href={`mailto:${r.email}`}
              onClick={(e) => e.stopPropagation()}
              className="text-[11px] text-[#2f6aa8] hover:underline truncate block"
            >
              {r.email}
            </a>
          );
        },
      }),

      col.accessor('email_status', {
        id: 'status',
        header: 'Status',
        cell: (info) => <StatusBadge status={info.getValue()} />,
        // Sort by usefulness, not by the alphabet the enum happens to use, so
        // "worst first" is one click and lands on what needs attention.
        sortingFn: (a, b) => STATUS_RANK[a.original.email_status] - STATUS_RANK[b.original.email_status],
      }),

      col.accessor('email_provider', {
        id: 'provider',
        header: 'Found by',
        cell: (info) => {
          const r = info.row.original;
          if (!r.email) return <Dash />;
          return <ProviderChip endpointId={r.email_provider} />;
        },
      }),

      col.accessor('credits', {
        id: 'credits',
        header: 'Credits',
        cell: (info) => (
          <CreditsCell credits={info.getValue() as number} worked={!isWorking(info.row.original)} />
        ),
      }),
    ],
    [],
  );

  const visible = React.useMemo(
    () => columns.filter((c) => !hidden.has(String(c.id))),
    [columns, hidden],
  );

  const table = useReactTable({
    data: rows,
    columns: visible,
    state: { sorting, globalFilter: query },
    onSortingChange: setSorting,
    onGlobalFilterChange: setQuery,
    globalFilterFn: (row, _id, filterValue) => {
      const q = String(filterValue ?? '').toLowerCase().trim();
      if (!q) return true;
      const r = row.original;
      return [r.company_name, r.domain, r.person_name, r.title, r.email].filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    enableRowSelection: true,
  });

  const model = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: model.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 12,
  });

  // Selection pruned against what is on screen. Rows stream in and a running run's
  // rows are removed as they are re-verified, so a selection that outlives its
  // rows would quietly act on different people than the ones highlighted.
  React.useEffect(() => {
    setPicked((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(rows.map((r) => r.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const toggleExpand = async (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    // Fetched per row, not with the page. Ten thousand rows of attempts would be
    // a hundred thousand rows to answer a question about one person.
    if (!attempts[id] && attemptsFor) {
      // The placeholder goes in first so a second click while this is in flight
      // does not fire a second request, then the real answer replaces it. The
      // await is outside the updater: an updater must be a pure function of the
      // previous state, and awaiting inside one means the state it reads is not
      // the state it was called with.
      setAttempts((p) => ({ ...p, [id]: [] }));
      try {
        const fetched = await attemptsFor(id);
        setAttempts((p) => ({ ...p, [id]: fetched }));
      } catch {
        // Left as the empty placeholder. A row that cannot show its history shows
        // "no provider history" rather than an error, because the address above
        // it is still real and correct.
      }
    }
  };

  const selectedIds = [...picked];

  const bulk = async (action: 'delete' | 'reverify') => {
    if (!onBulk || selectedIds.length === 0) return;
    setBusy(action);
    setNote(null);
    try {
      const res = await onBulk(action, selectedIds);
      if (!res.ok) {
        setNote(res.error ?? 'That did not work.');
        return;
      }
      setNote(
        action === 'delete'
          ? `${selectedIds.length} rows removed.`
          : `${selectedIds.length} rows queued for another check.`,
      );
      setPicked(new Set());
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="bg-white border border-[#e3e3de]">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <RowSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No rows yet"
        body="Companies appear here within seconds of being found. If the run is working, give it a moment."
      />
    );
  }

  const gridTemplate = visible.map((c) => GRID[String(c.id)] ?? '1fr').join(' ');

  return (
    <div className="bg-white border border-[#e3e3de]">
      {/* ---- Toolbar ------------------------------------------------------ */}
      <div className="flex items-center gap-2 px-4 h-11 border-b border-[#e3e3de]">
        <Search className="w-3 h-3 text-[#b5b5ad] flex-shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search company, person or email"
          className="flex-1 min-w-0 bg-transparent text-[11px] font-mono text-[#141414] placeholder:text-[#b5b5ad] focus:outline-none"
        />

        <span className="text-[10px] font-mono text-[#8a8a86] tabular-nums flex-shrink-0">
          {model.length === rows.length ? `${rows.length}` : `${model.length} of ${rows.length}`}
          {total > rows.length && rows.length < total && ` of ${total}`}
        </span>

        {query && (
          <button
            onClick={() => setQuery('')}
            className="text-[#b5b5ad] hover:text-[#141414] cursor-pointer flex-shrink-0"
            aria-label="Clear search"
          >
            <X className="w-3 h-3" />
          </button>
        )}

        <div className="w-px h-4 bg-[#e3e3de] flex-shrink-0" />

        <button
          onClick={() => setDense((d) => !d)}
          className={`text-[10px] font-mono uppercase tracking-wider transition-colors cursor-pointer flex-shrink-0 px-1.5 py-1 ${
            dense ? 'text-[#141414] bg-[#f0f0ec]' : 'text-[#8a8a86] hover:text-[#141414]'
          }`}
          title={dense ? 'Comfortable rows' : 'Compact rows'}
        >
          {dense ? 'Compact' : 'Roomy'}
        </button>

        <div className="relative flex-shrink-0">
          <button
            onClick={() => setShowCols((v) => !v)}
            className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] hover:text-[#141414] transition-colors cursor-pointer px-1.5 py-1"
          >
            <Columns3 className="w-3 h-3" />
            Columns
          </button>
          {showCols && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowCols(false)} />
              <div className="absolute right-0 top-full mt-1 z-20 w-48 bg-white border border-[#e3e3de] shadow-lg py-1">
                {ALL_COLUMNS.filter((c) => !c.always).map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-[#f6f6f4] cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={!hidden.has(c.id)}
                      onChange={(e) =>
                        setHidden((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.delete(c.id);
                          else next.add(c.id);
                          return next;
                        })
                      }
                      className="accent-[#141414]"
                    />
                    <span className="text-[10px] font-mono text-[#4a4a47]">{c.label}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ---- Bulk bar ------------------------------------------------------ */}
      {selectedIds.length > 0 && (
        <BulkBar
          count={selectedIds.length}
          busy={busy}
          note={note}
          onReverify={() => void bulk('reverify')}
          onSuppress={() => onSuppress?.(selectedIds)}
          onDelete={() => void bulk('delete')}
          onClear={() => {
            setPicked(new Set());
            setNote(null);
          }}
        />
      )}
      {!selectedIds.length && note && (
        <div className="px-4 py-2 border-b border-[#eeeeea] bg-[#f6f6f4] text-[10px] font-mono text-[#4a4a47]">
          {note}
        </div>
      )}

      {/* ---- Header --------------------------------------------------------- */}
      <div
        className="grid items-center gap-3 px-4 h-9 border-b border-[#e3e3de] bg-[#fbfbfa] sticky top-0 z-[5]"
        style={{ gridTemplateColumns: `28px ${gridTemplate}` }}
      >
        <SelectAll
          checked={picked.size > 0 && picked.size === model.length}
          some={picked.size > 0 && picked.size < model.length}
          onChange={(on) => setPicked(on ? new Set(model.map((r) => r.original.id)) : new Set())}
        />
        {table.getFlatHeaders().map((h) => (
          <HeaderCell key={h.id} header={h} />
        ))}
      </div>

      {/* ---- Body ----------------------------------------------------------- */}
      <div ref={scrollRef} className="overflow-auto" style={{ height: 'min(66vh, 760px)' }}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = model[vi.index];
            const r = row.original;
            const open = expanded === r.id;
            const isPicked = picked.has(r.id);

            return (
              <React.Fragment key={row.id}>
                <div
                  className={`absolute left-0 right-0 grid items-center gap-3 px-4 border-b border-[#eeeeea] cursor-pointer ${
                    open ? 'bg-[#f6f6f4]' : isPicked ? 'bg-[#f0f4f8]' : 'hover:bg-[#fbfbfa]'
                  }`}
                  style={{ height: rowH, gridTemplateColumns: `28px ${gridTemplate}`, transform: `translateY(${vi.start}px)` }}
                  onClick={() => void toggleExpand(r.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void toggleExpand(r.id);
                    }
                  }}
                >
                  <Checkbox
                    checked={isPicked}
                    onChange={() =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (next.has(r.id)) next.delete(r.id);
                        else next.add(r.id);
                        return next;
                      })
                    }
                    onClick={(e) => e.stopPropagation()}
                  />

                  {row.getVisibleCells().map((cell) => (
                    <div key={cell.id} className="min-w-0 overflow-hidden">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
                </div>

                {open && (
                  <Expanded
                    row={r}
                    attempts={attempts[r.id] ?? []}
                    onClose={() => setExpanded(null)}
                    top={vi.start + rowH}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** Per-column widths, so the grid template and the header cannot disagree. */
const GRID: Record<string, string> = {
  company: 'minmax(0,1.5fr)',
  person: 'minmax(0,1.1fr)',
  title: 'minmax(0,0.9fr)',
  domain: 'minmax(0,1fr)',
  email: 'minmax(0,1.6fr)',
  status: '110px',
  provider: '130px',
  credits: '70px',
};

/** Worst first, because that is the order anybody sorting by status wants. */
const STATUS_RANK: Record<string, number> = {
  invalid: 0,
  not_found: 1,
  unknown: 2,
  catch_all: 3,
  verified: 4,
};

const Dash = () => <span className="text-[#d5d5cf] text-[10px] font-mono">—</span>;

/**
 * What a row being worked on shows in the address column.
 *
 * The provider name and nothing else. The ladder of rungs is in the expanded row
 * now, where there is room to draw it; putting a five-step diagram in every cell
 * of every row turned the table into a column of small graphics nobody could
 * read at 500 rows.
 */
const Working: React.FC<{ provider: string | null }> = ({ provider }) => (
  <span className="inline-flex items-center gap-1.5">
    <span className="w-1.5 h-1.5 rounded-full bg-[#141414] animate-pulse" />
    <span className="text-[10px] font-mono text-[#8a8a86]">
      {provider ? providerStyle(provider).label : 'starting'}
    </span>
  </span>
);

const Checkbox: React.FC<{ checked: boolean; some?: boolean; onChange: () => void; onClick?: (e: React.MouseEvent) => void }> = ({
  checked,
  some,
  onChange,
  onClick,
}) => (
  <span className="flex items-center justify-center" onClick={onClick}>
    <input
      type="checkbox"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = Boolean(some) && !checked;
      }}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className="w-3 h-3 accent-[#141414] cursor-pointer"
      aria-label="Select row"
    />
  </span>
);

const SelectAll: React.FC<{ checked: boolean; some: boolean; onChange: (on: boolean) => void }> = ({
  checked,
  some,
  onChange,
}) => (
  <Checkbox checked={checked} some={some} onChange={() => onChange(!checked)} />
);

const HeaderCell: React.FC<{ header: ReturnType<ReturnType<typeof useReactTable<LeadRow>>['getFlatHeaders']>[number] }> = ({
  header,
}) => {
  const sorted = header.column.getIsSorted();
  const canSort = header.column.getCanSort();
  const label = typeof header.column.columnDef.header === 'string' ? header.column.columnDef.header : header.column.id;

  if (!canSort) {
    return (
      <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] truncate">
        {label}
      </span>
    );
  }

  return (
    <button
      onClick={header.column.getToggleSortingHandler()}
      className="group flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] hover:text-[#141414] transition-colors cursor-pointer min-w-0"
    >
      <span className="truncate">{label}</span>
      {sorted === 'asc' ? (
        <ArrowUp className="w-2.5 h-2.5 text-[#141414] flex-shrink-0" />
      ) : sorted === 'desc' ? (
        <ArrowDown className="w-2.5 h-2.5 text-[#141414] flex-shrink-0" />
      ) : (
        <span className="w-2.5 h-2.5 flex-shrink-0 opacity-0 group-hover:opacity-40 transition-opacity">
          <ArrowUp className="w-2.5 h-2.5" />
        </span>
      )}
    </button>
  );
};

/**
 * What sits under a row when it opens.
 *
 * The waterfall is the reason to open it. The company details underneath are
 * there because they are what somebody actually wants to read, but they are
 * secondary and laid out as key-value text rather than given equal weight — a row
 * that leads with a chart and follows it with a paragraph would be making the
 * chart optional.
 */
const Expanded: React.FC<{
  row: LeadRow;
  attempts: LeadAttempt[];
  onClose: () => void;
  top: number;
}> = ({ row, attempts, onClose, top }) => {
  const facts = Object.entries(row.company_data ?? {}).slice(0, 8);

  return (
    <div
      className="absolute left-0 right-0 bg-[#fbfbfa] border-b border-[#e3e3de] px-4 py-4"
      style={{ top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          {attempts.length > 0 ? (
            <WaterfallChain attempts={attempts} />
          ) : (
            <p className="text-[10px] font-mono text-[#8a8a86] py-2">
              {row.email ? 'No provider history for this row.' : 'No provider tried yet.'}
            </p>
          )}
        </div>

        <button
          onClick={onClose}
          className="text-[#b5b5ad] hover:text-[#141414] transition-colors cursor-pointer flex-shrink-0"
          aria-label="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {facts.length > 0 && (
        <dl className="flex flex-wrap gap-x-8 gap-y-1.5 mt-4 pt-3 border-t border-[#eeeeea]">
          {facts.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-[9px] font-mono uppercase tracking-wider text-[#b5b5ad]">{k.replace(/_/g, ' ')}</dt>
              <dd className="text-[10px] font-mono text-[#4a4a47] truncate">{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
};

/**
 * What appears when rows are ticked.
 *
 * Replaces the toolbar rather than sitting below it, so the row count does not
 * jump and the table does not move under the cursor at the moment somebody is
 * about to click something irreversible.
 */
const BulkBar: React.FC<{
  count: number;
  busy: string | null;
  note: string | null;
  onReverify: () => void;
  onSuppress: () => void;
  onDelete: () => void;
  onClear: () => void;
}> = ({ count, busy, note, onReverify, onSuppress, onDelete, onClear }) => (
  <div className="flex items-center gap-2 px-4 h-11 border-b border-[#e3e3de] bg-[#141414] text-white">
    <span className="text-[10px] font-mono tabular-nums flex-shrink-0">
      {count} selected
    </span>

    <div className="w-px h-4 bg-white/20 flex-shrink-0" />

    <Action onClick={onReverify} disabled={busy !== null} icon={<RefreshCw className="w-3 h-3" />} busy={busy === 'reverify'}>
      Check again
    </Action>
    <Action onClick={onSuppress} disabled={busy !== null} icon={<ShieldOff className="w-3 h-3" />}>
      Never contact
    </Action>
    <Action onClick={onDelete} disabled={busy !== null} icon={<Trash2 className="w-3 h-3" />} busy={busy === 'delete'} danger>
      Delete
    </Action>

    {note && <span className="text-[10px] font-mono text-white/70 ml-2 truncate">{note}</span>}

    <button
      onClick={onClear}
      className="ml-auto text-[10px] font-mono uppercase tracking-wider text-white/60 hover:text-white transition-colors cursor-pointer flex-shrink-0"
    >
      Clear
    </button>
  </div>
);

const Action: React.FC<{
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
  busy?: boolean;
  danger?: boolean;
}> = ({ children, onClick, disabled, icon, busy, danger }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`inline-flex items-center gap-1.5 px-2 py-1 text-[10px] font-mono uppercase tracking-wider transition-colors cursor-pointer disabled:opacity-40 ${
      danger ? 'text-white/70 hover:text-white' : 'text-white/80 hover:text-white'
    }`}
  >
    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : icon}
    {children}
  </button>
);

export { ChevronRight };
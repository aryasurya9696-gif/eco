import React from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  createColumnHelper,
  flexRender,
  type SortingState,
  type Column,
  type Table,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowUpDown, Search } from 'lucide-react';
import type { LeadRow } from '../../types';
import { StatusBadge, CreditsCell } from './StatusBadge';
import { CellLadder } from './CellLadder';
import { ProviderChip } from './ProviderChip';
import { RowReceipt } from './CountLine';
import { EmptyState, RowSkeleton } from './EmptyPanel';

/**
 * The run table — the screen people screenshot.
 *
 * Virtualised, so ten thousand rows scroll at the same speed as ten. The row is a
 * fixed 44px and so is the header at 40px, and the skeleton matches both exactly:
 * a table that changes height when data lands reads as a rendering bug even when
 * it is not.
 *
 * Nothing here decides anything about a lead. It renders what the worker found
 * and what it cost, and every cell's state is one the database will accept —
 * because the alternative is a green tick sitting beside an address no verifier
 * ever confirmed.
 */

interface LeadsTableProps {
  rows: LeadRow[];
  total: number;
  loading?: boolean;
  /** Attempt history, fetched only for the row being expanded. */
  attemptsFor?: (rowId: string) => Promise<import('../../types').LeadAttempt[]>;
  onRowDeleted?: (rowId: string) => void;
}

const col = createColumnHelper<LeadRow>();

/** In flight means the waterfall has something to say; done does not. */
const isWorking = (r: LeadRow) => r.state === 'trying' || r.state === 'queued' || r.state === 'miss';

export const LeadsTable: React.FC<LeadsTableProps> = ({
  rows,
  loading = false,
  attemptsFor,
}) => {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [query, setQuery] = React.useState('');
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [attempts, setAttempts] = React.useState<Record<string, import('../../types').LeadAttempt[]>>({});
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const columns = React.useMemo(
    () => [
      col.display({
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
                  className="w-5 h-5 rounded-none object-contain shrink-0"
                  // A provider logo that 404s should leave a gap, not a broken
                  // image icon sitting in every row.
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.visibility = 'hidden';
                  }}
                />
              ) : (
                <div className="w-5 h-5 bg-[#f0f0ec] shrink-0 rounded-none" aria-hidden="true" />
              )}
              <div className="min-w-0">
                <div className="text-[11px] text-[#141414] truncate">
                  {r.company_name || r.domain || '—'}
                </div>
                {r.domain && (
                  <div className="text-[9px] font-mono text-[#8a8a86] truncate">{r.domain}</div>
                )}
              </div>
            </div>
          );
        },
      }),

      col.display({
        id: 'person',
        header: 'Person',
        cell: (info) => {
          const r = info.row.original;
          if (!r.person_name) return <span className="text-[#b5b5ad] text-[10px] font-mono">—</span>;
          return (
            <div className="min-w-0">
              <div className="text-[11px] text-[#141414] truncate">{r.person_name}</div>
              {r.title && (
                <div className="text-[9px] font-mono text-[#8a8a86] truncate">{r.title}</div>
              )}
            </div>
          );
        },
      }),

      col.display({
        id: 'email',
        header: 'Email',
        cell: (info) => {
          const r = info.row.original;
          if (isWorking(r) && !r.email) return <CellLadder currentProvider={r.current_provider} state={r.state} />;
          if (!r.email) return <span className="text-[#b5b5ad] text-[10px] font-mono">—</span>;
          return (
            <a
              href={`mailto:${r.email}`}
              className="text-[11px] text-[#2f6aa8] hover:underline truncate block"
              onClick={(e) => e.stopPropagation()}
            >
              {r.email}
            </a>
          );
        },
      }),

      col.display({
        id: 'status',
        header: 'Status',
        cell: (info) => <StatusBadge status={info.row.original.email_status} />,
      }),

      col.display({
        id: 'provider',
        header: 'Found by',
        cell: (info) => {
          const r = info.row.original;
          if (isWorking(r) && !r.email) return <span className="text-[#b5b5ad]">—</span>;
          return <ProviderChip endpointId={r.email_provider} />;
        },
      }),

      col.display({
        id: 'credits',
        header: 'Credits',
        cell: (info) => (
          <CreditsCell credits={info.row.original.credits} worked={!isWorking(info.row.original)} />
        ),
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter: query },
    onSortingChange: setSorting,
    onGlobalFilterChange: setQuery,
    globalFilterFn: (row, _columnId, filterValue) => {
      const q = String(filterValue ?? '').toLowerCase().trim();
      if (!q) return true;
      const r = row.original;
      return [r.company_name, r.domain, r.person_name, r.title, r.email]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const rowsModel = table.getRowModel().rows;

  const virtualizer = useVirtualizer({
    count: rowsModel.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 12,
  });

  const toggleExpand = async (rowId: string) => {
    if (expanded === rowId) {
      setExpanded(null);
      return;
    }
    setExpanded(rowId);
    // Attempt history is fetched per row, not with the page. Ten thousand rows
    // of attempts would be a hundred thousand rows to answer a question about
    // one person.
    if (!attempts[rowId] && attemptsFor) {
      setAttempts((prev) => ({ ...prev, [rowId]: [] }));
      try {
        const a = await attemptsFor(rowId);
        setAttempts((prev) => ({ ...prev, [rowId]: a }));
      } catch {
        setAttempts((prev) => ({ ...prev, [rowId]: [] }));
      }
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
        title="Nothing here yet"
        body="No rows in this run. If it is still working, companies appear here within seconds of being found."
      />
    );
  }

  return (
    <div className="bg-white border border-[#e3e3de]">
      {/* Search */}
      <div className="flex items-center gap-2 px-4 h-10 border-b border-[#e3e3de]">
        <Search className="w-3 h-3 text-[#b5b5ad]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search company, person or email"
          className="flex-1 bg-transparent text-[11px] font-mono text-[#141414] placeholder:text-[#b5b5ad] focus:outline-none"
        />
        <span className="text-[10px] font-mono text-[#8a8a86] tabular-nums">
          {rowsModel.length === rows.length
            ? `${rows.length}`
            : `${rowsModel.length} of ${rows.length}`}
        </span>
      </div>

      {/* Header — 40px, fixed. */}
      <div className="grid grid-cols-[1.6fr_1.2fr_1.6fr_0.9fr_0.9fr_0.5fr] h-10 items-center px-4 border-b border-[#e3e3de] bg-[#fbfbfa]">
        {table.getAllLeafColumns().map((c) => (
          <SortableHeader key={c.id} column={c} table={table} />
        ))}
      </div>

      {/* Body — 44px rows, virtualised. */}
      <div ref={scrollRef} className="overflow-auto" style={{ height: 'min(62vh, 720px)' }}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rowsModel[vi.index];
            const r = row.original;
            const isOpen = expanded === r.id;

            return (
              <React.Fragment key={row.id}>
                <div
                  className={`absolute left-0 right-0 grid grid-cols-[1.6fr_1.2fr_1.6fr_0.9fr_0.9fr_0.5fr] items-center px-4 cursor-pointer border-b border-[#eeeeea] ${
                    isOpen ? 'bg-[#f6f6f4]' : 'hover:bg-[#fbfbfa]'
                  }`}
                  style={{ height: 44, transform: `translateY(${vi.start}px)` }}
                  onClick={() => toggleExpand(r.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleExpand(r.id);
                    }
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <div key={cell.id} className="pr-3 min-w-0 overflow-hidden">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
                </div>

                {isOpen && (
                  <div
                    className="absolute left-0 right-0 bg-[#fbfbfa] border-b border-[#e3e3de] px-4 py-3"
                    style={{ height: 150, transform: `translateY(${vi.start + 44}px)` }}
                  >
                    <RowReceipt
                      attempts={attempts[r.id] ?? []}
                      totalCostUsd={undefined}
                    />
                    {r.company_data &&
                      Object.keys(r.company_data).length > 0 && (
                        <div className="mt-3 pt-3 border-t border-[#eeeeea] text-[10px] font-mono text-[#4a4a47]">
                          {Object.entries(r.company_data)
                            .slice(0, 6)
                            .map(([k, v]) => (
                              <span key={k} className="mr-4 inline-block">
                                <span className="text-[#8a8a86]">{k.replace(/_/g, ' ')}: </span>
                                {String(v)}
                              </span>
                            ))}
                        </div>
                      )}
                  </div>
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
// Header
// ---------------------------------------------------------------------------

const SortableHeader: React.FC<{
  // The real leaf column, rather than a re-derived label, so the sorted state
  // shown is the state the body is actually sorted by.
  column: Column<LeadRow, unknown>;
  table: Table<LeadRow>;
}> = ({ column, table }) => {
  const resolved = table.getColumn(column.id);
  const sorted = resolved?.getIsSorted();
  const label =
    typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id;

  return (
    <button
      onClick={() => {
        const handler = resolved?.getToggleSortingHandler();
        if (handler) handler(undefined);
      }}
      className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] hover:text-[#141414] transition-colors cursor-pointer text-left"
    >
      {label}
      <ArrowUpDown className={`w-2.5 h-2.5 ${sorted ? 'opacity-100' : 'opacity-0'}`} />
    </button>
  );
};

import React, { useState } from 'react';
import type { B2BLead, B2BPipelineStatus } from '../../types';
import { downloadCsv, downloadTextFile } from '../../lib/csv';
import {
  Search,
  Copy,
  Check,
  Building2,
  Bookmark,
  FileSpreadsheet,
  FileJson,
  RefreshCw,
  Loader2,
  Trash2,
  CheckSquare,
  Square,
  ExternalLink,
  AlertCircle,
} from 'lucide-react';

const LinkedinIcon: React.FC<{ className?: string }> = ({ className = 'w-3 h-3' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z"/>
  </svg>
);

interface SavedLeadsViewProps {
  leads: B2BLead[];
  isLoading?: boolean;
  onStatusChange: (lead: B2BLead, status: B2BPipelineStatus) => Promise<boolean | void>;
  onDeleteLead?: (lead: B2BLead) => Promise<void>;
  onBulkDelete?: (leads: B2BLead[]) => Promise<void>;
  onRefresh?: () => Promise<void>;
  /** The server stopped at its 2,000-row page limit. */
  limitReached?: boolean;
}

/** Every field on user_leads is nullable, so nothing here may assume a string. */
const text = (value?: string | null): string => (value ?? '').toLowerCase();

export const SavedLeadsView: React.FC<SavedLeadsViewProps> = ({
  leads,
  isLoading = false,
  onStatusChange,
  onDeleteLead,
  onBulkDelete,
  onRefresh,
  limitReached = false,
}) => {
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  // A delete is permanent and the contact may have cost credits to reveal, so
  // it arms first and runs on a second click.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const filteredLeads = leads.filter((lead) => {
    const matchesStatus = filterStatus === 'all' || lead.status === filterStatus;
    if (!matchesStatus) return false;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      text(lead.full_name).includes(q) ||
      text(lead.company_name).includes(q) ||
      text(lead.company_domain).includes(q) ||
      text(lead.work_email).includes(q) ||
      text(lead.phone_number).includes(q) ||
      text(lead.title).includes(q)
    );
  });

  const allFilteredSelected =
    filteredLeads.length > 0 && filteredLeads.every((l) => selectedIds.has(l.id));

  const toggleSelectAll = () => {
    setConfirmBulkDelete(false);
    if (allFilteredSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredLeads.map((l) => l.id)));
    }
  };

  const toggleSelect = (id: string) => {
    setConfirmBulkDelete(false);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedLeads = filteredLeads.filter((l) => selectedIds.has(l.id));

  const handleCopy = async (value: string, id: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Clipboard access can be denied (insecure origin, permission). Showing
      // the tick anyway claimed the value was copied when it was not.
    }
  };

  const stamp = () => new Date().toISOString().slice(0, 10);

  const exportCSV = (targetLeads = filteredLeads) => {
    if (targetLeads.length === 0) return;
    downloadCsv(
      `echo_leads_export_${stamp()}.csv`,
      [
        ['Full Name', 'Title', 'Company Name', 'Domain', 'Work Email', 'Phone', 'LinkedIn', 'Status', 'Location', 'Added'],
        ...targetLeads.map((l) => [
          l.full_name || '',
          l.title || '',
          l.company_name || '',
          l.company_domain || '',
          l.work_email || '',
          l.phone_number || '',
          l.linkedin_url || '',
          l.status || 'new',
          l.location || '',
          l.created_at || '',
        ]),
      ],
    );
  };

  const exportJSON = (targetLeads = filteredLeads) => {
    if (targetLeads.length === 0) return;
    downloadTextFile(
      `echo_leads_export_${stamp()}.json`,
      JSON.stringify(targetLeads, null, 2),
      'application/json',
    );
  };

  const handleDelete = async (lead: B2BLead) => {
    if (!onDeleteLead) return;
    setDeletingId(lead.id);
    try {
      await onDeleteLead(lead);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(lead.id);
        return next;
      });
    } finally {
      setDeletingId(null);
    }
  };

  const handleBulkDelete = async () => {
    if (!onBulkDelete || selectedLeads.length === 0) return;
    setIsBulkDeleting(true);
    try {
      await onBulkDelete(selectedLeads);
      setSelectedIds(new Set());
      setConfirmBulkDelete(false);
    } finally {
      setIsBulkDeleting(false);
    }
  };

  return (
    <div className="space-y-4 font-mono">
      {/* Top Filter & Export Bar */}
      <div className="bg-white border border-[#e3e3de] p-4 flex flex-wrap items-center justify-between gap-3 shadow-[0_1px_3px_rgba(0,0,0,0.02)]">
        {/* Search Input */}
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-3.5 h-3.5 text-[#8a8a86] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setConfirmBulkDelete(false);
            }}
            placeholder="Search saved prospects by name, company, email, phone..."
            className="w-full pl-9 pr-3 py-1.5 bg-[#fafaf8] border border-[#e3e3de] focus:border-[#141414] focus:bg-white text-xs text-[#141414] placeholder-[#8a8a86] outline-none"
          />
        </div>

        {/* Status Filter Chips */}
        <div className="flex items-center gap-1">
          {['all', 'new', 'contacted', 'replied', 'dismissed'].map((st) => (
            <button
              key={st}
              onClick={() => {
                setFilterStatus(st);
                setConfirmBulkDelete(false);
              }}
              className={`px-2.5 py-1 text-[11px] uppercase tracking-wider transition-colors cursor-pointer border ${
                filterStatus === st
                  ? 'bg-[#141414] text-[#f6f6f4] border-[#141414]'
                  : 'bg-[#fafaf8] hover:bg-[#eeeeea] text-[#8a8a86] border-[#e3e3de]'
              }`}
            >
              {st}
            </button>
          ))}
        </div>

        {/* Refresh, Export Buttons */}
        <div className="flex items-center gap-2">
          {onRefresh && (
            <button
              onClick={onRefresh}
              disabled={isLoading}
              className="px-3 py-1.5 bg-white hover:bg-[#f6f6f4] text-[#141414] border border-[#e3e3de] text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40"
              title="Reload from the pipeline"
            >
              {isLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 text-[#8a8a86]" />
              )}
              <span>REFRESH</span>
            </button>
          )}

          <button
            onClick={() => exportCSV()}
            disabled={filteredLeads.length === 0}
            className="px-3 py-1.5 bg-white hover:bg-[#f6f6f4] text-[#141414] border border-[#e3e3de] text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40"
            title="Download CSV"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
            <span>CSV</span>
          </button>
          <button
            onClick={() => exportJSON()}
            disabled={filteredLeads.length === 0}
            className="px-3 py-1.5 bg-white hover:bg-[#f6f6f4] text-[#141414] border border-[#e3e3de] text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40"
            title="Download JSON"
          >
            <FileJson className="w-3.5 h-3.5 text-blue-600" />
            <span>JSON</span>
          </button>
        </div>
      </div>

      {/* Bulk Selection Actions Bar */}
      {selectedLeads.length > 0 && (
        <div className="bg-[#141414] text-[#f6f6f4] px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 shadow-md animate-in fade-in duration-150">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-semibold text-amber-300">{selectedLeads.length}</span>
            <span>prospect(s) selected</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => exportCSV(selectedLeads)}
              className="px-2.5 py-1 bg-white/10 hover:bg-white/20 text-xs text-white border border-white/20 flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <FileSpreadsheet className="w-3 h-3 text-emerald-400" />
              <span>Export CSV ({selectedLeads.length})</span>
            </button>

            {onBulkDelete && (
              <button
                onClick={() => {
                  if (!confirmBulkDelete) {
                    setConfirmBulkDelete(true);
                    return;
                  }
                  handleBulkDelete();
                }}
                disabled={isBulkDeleting}
                className={`px-2.5 py-1 text-xs text-white flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 ${
                  confirmBulkDelete
                    ? 'bg-rose-800 hover:bg-rose-900 border border-rose-300 font-semibold'
                    : 'bg-rose-600 hover:bg-rose-700'
                }`}
              >
                {isBulkDeleting ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Trash2 className="w-3 h-3" />
                )}
                <span>
                  {confirmBulkDelete
                    ? `Permanently delete ${selectedLeads.length}?`
                    : `Delete Selected (${selectedLeads.length})`}
                </span>
              </button>
            )}

            {confirmBulkDelete && !isBulkDeleting && (
              <button
                onClick={() => setConfirmBulkDelete(false)}
                className="text-xs text-[#a8a8a2] hover:text-white underline cursor-pointer"
              >
                Cancel
              </button>
            )}

            <button
              onClick={() => {
                setSelectedIds(new Set());
                setConfirmBulkDelete(false);
              }}
              className="text-xs text-[#a8a8a2] hover:text-white underline ml-2 cursor-pointer"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Leads Table / List */}
      <div className="bg-white border border-[#e3e3de] overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.02)]">
        {limitReached && (
          <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-800 flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              Showing the 2,000 most recent prospects. Older saved leads are still
              stored — delete some, then hit Refresh to see the rest.
            </span>
          </div>
        )}
        {filteredLeads.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-[#fafaf8] border-b border-[#e3e3de] text-[10px] font-mono text-[#8a8a86] uppercase tracking-wider font-semibold">
                  <th className="py-3 px-3 w-8">
                    <button onClick={toggleSelectAll} className="cursor-pointer">
                      {allFilteredSelected ? (
                        <CheckSquare className="w-3.5 h-3.5 text-[#141414]" />
                      ) : (
                        <Square className="w-3.5 h-3.5 text-[#8a8a86]" />
                      )}
                    </button>
                  </th>
                  <th className="py-3 px-3">Contact</th>
                  <th className="py-3 px-3">Company</th>
                  <th className="py-3 px-3">Verified Email</th>
                  <th className="py-3 px-3">Phone</th>
                  <th className="py-3 px-3">Pipeline Status</th>
                  <th className="py-3 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#eeeeea]">
                {filteredLeads.map((lead) => {
                  const isSelected = selectedIds.has(lead.id);
                  const isDeleting = deletingId === lead.id;

                  return (
                    <tr
                      key={lead.id}
                      className={`hover:bg-[#fafaf8] transition-colors ${
                        isSelected ? 'bg-amber-50/30' : ''
                      }`}
                    >
                      {/* Checkbox */}
                      <td className="py-3 px-3">
                        <button onClick={() => toggleSelect(lead.id)} className="cursor-pointer">
                          {isSelected ? (
                            <CheckSquare className="w-3.5 h-3.5 text-[#141414]" />
                          ) : (
                            <Square className="w-3.5 h-3.5 text-[#8a8a86]" />
                          )}
                        </button>
                      </td>

                      {/* Contact Name & Title */}
                      <td className="py-3.5 px-3">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-full bg-[#141414] text-[#f6f6f4] flex items-center justify-center text-[10px] font-semibold shrink-0">
                            {lead.full_name ? lead.full_name.slice(0, 2).toUpperCase() : 'LD'}
                          </div>
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-xs text-[#141414]">
                                {lead.full_name || 'Unnamed prospect'}
                              </span>
                              {lead.linkedin_url && (
                                <a
                                  href={lead.linkedin_url.startsWith('http') ? lead.linkedin_url : `https://${lead.linkedin_url}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[#8a8a86] hover:text-[#0077b5]"
                                  title="LinkedIn Profile"
                                >
                                  <LinkedinIcon className="w-3 h-3" />
                                </a>
                              )}
                            </div>
                            <span className="text-[11px] text-[#8a8a86] block truncate max-w-[180px]">
                              {lead.title || '—'}
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* Company */}
                      <td className="py-3.5 px-3">
                        <div className="flex items-center gap-1.5">
                          <Building2 className="w-3 h-3 text-[#8a8a86] shrink-0" />
                          <span className="font-medium text-xs text-[#141414] truncate max-w-[160px]">
                            {lead.company_name || '—'}
                          </span>
                        </div>
                        {lead.company_domain && (
                          <a
                            href={`https://${lead.company_domain}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-[#8a8a86] hover:underline flex items-center gap-0.5 mt-0.5"
                          >
                            <span>{lead.company_domain}</span>
                            <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                          </a>
                        )}
                      </td>

                      {/* Work Email */}
                      <td className="py-3.5 px-3">
                        {lead.work_email ? (
                          <div className="flex items-center gap-1.5">
                            <a
                              href={`mailto:${lead.work_email}`}
                              className="text-xs text-[#141414] hover:underline"
                            >
                              {lead.work_email}
                            </a>
                            <button
                              onClick={() => handleCopy(lead.work_email!, `em_${lead.id}`)}
                              className="p-1 text-[#8a8a86] hover:text-[#141414] cursor-pointer"
                              title="Copy email"
                            >
                              {copiedId === `em_${lead.id}` ? (
                                <Check className="w-3 h-3 text-emerald-600" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                            </button>
                            {lead.email_status && (
                              <span
                                className={`text-[9px] font-bold uppercase px-1 py-0.2 border ${
                                  lead.email_status === 'valid' || lead.email_status === 'deliverable'
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                    : 'bg-blue-50 text-blue-700 border-blue-200'
                                }`}
                              >
                                {lead.email_status}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-[#8a8a86] text-[11px]">—</span>
                        )}
                      </td>

                      {/* Phone */}
                      <td className="py-3.5 px-3">
                        {lead.phone_number ? (
                          <div className="flex items-center gap-1.5">
                            <a
                              href={`tel:${lead.phone_number}`}
                              className="text-xs text-[#141414] hover:underline"
                            >
                              {lead.phone_number}
                            </a>
                            <button
                              onClick={() => handleCopy(lead.phone_number!, `ph_${lead.id}`)}
                              className="p-1 text-[#8a8a86] hover:text-[#141414] cursor-pointer"
                              title="Copy phone"
                            >
                              {copiedId === `ph_${lead.id}` ? (
                                <Check className="w-3 h-3 text-emerald-600" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                            </button>
                          </div>
                        ) : (
                          <span className="text-[#8a8a86] text-[11px]">—</span>
                        )}
                      </td>

                      {/* Status Select */}
                      <td className="py-3.5 px-3">
                        <select
                          value={lead.status || 'new'}
                          onChange={(e) => onStatusChange(lead, e.target.value as B2BPipelineStatus)}
                          className={`text-[11px] font-mono px-2 py-1 rounded border cursor-pointer focus:outline-none transition-colors ${
                            lead.status === 'replied'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold'
                              : lead.status === 'contacted'
                              ? 'bg-blue-50 text-blue-700 border-blue-200 font-medium'
                              : lead.status === 'dismissed'
                              ? 'bg-[#fafaf8] text-[#8a8a86] border-[#e3e3de]'
                              : 'bg-amber-50 text-amber-700 border-amber-200 font-medium'
                          }`}
                        >
                          <option value="new">New</option>
                          <option value="contacted">Contacted</option>
                          <option value="replied">Replied</option>
                          <option value="dismissed">Dismissed</option>
                        </select>
                      </td>

                      {/* Action: Delete */}
                      <td className="py-3.5 px-3 text-right">
                        {onDeleteLead &&
                          (isDeleting ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-600 ml-auto" />
                          ) : pendingDeleteId === lead.id ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => {
                                  setPendingDeleteId(null);
                                  handleDelete(lead);
                                }}
                                className="px-1.5 py-0.5 bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-semibold cursor-pointer"
                                title="Delete permanently"
                              >
                                DELETE
                              </button>
                              <button
                                onClick={() => setPendingDeleteId(null)}
                                className="text-[10px] text-[#8a8a86] hover:text-[#141414] underline cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setPendingDeleteId(lead.id)}
                              className="p-1.5 text-[#8a8a86] hover:text-rose-600 hover:bg-rose-50 rounded transition-colors cursor-pointer"
                              title="Remove from pipeline"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-12 text-center">
            <Bookmark className="w-8 h-8 text-[#8a8a86] mx-auto mb-3 opacity-50" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[#141414] mb-1">
              No Saved Prospects Found
            </h3>
            <p className="text-xs text-[#8a8a86] max-w-sm mx-auto">
              {searchQuery || filterStatus !== 'all'
                ? 'No saved leads match your active filters.'
                : 'When you reveal contacts in the Prospector or Quick Lookup, they are automatically saved here for outreach.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
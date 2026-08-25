import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Repeat, Search, Filter, Upload, FileSpreadsheet, Link2, RefreshCw, History, Loader2,
  ChevronLeft, ChevronRight, Inbox, X, CheckCircle2, AlertCircle,
} from 'lucide-react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';

const PAGE_SIZE = 20;

const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'exit_url', label: 'Exit URL' },
  { key: 'retarget_type', label: 'Retarget Type' },
  { key: 'source', label: 'Source' },
  { key: 'status', label: 'Status' },
  { key: 'created_at', label: 'Created At' },
];

function formatCell(key, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (key === 'created_at') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  return String(value);
}

export default function RetargetPage() {
  const [customers, setCustomers] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  // Import / sync UI state
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState(null); // { imported, updated, skipped, errors }
  const [importError, setImportError] = useState('');
  const csvInputRef = useRef(null);
  const excelInputRef = useRef(null);

  const [sheetModalOpen, setSheetModalOpen] = useState(false);
  const [sheetUrlInput, setSheetUrlInput] = useState('');
  const [sheetSettings, setSheetSettings] = useState(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetError, setSheetError] = useState('');

  const [syncBusy, setSyncBusy] = useState(false);

  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [historyRows, setHistoryRows] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // ── Row selection (persists across search / pagination / filtering) ────
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedDetails, setSelectedDetails] = useState(() => new Map()); // id -> row data, for Export
  const headerCheckboxRef = useRef(null);

  // ── Filters ──────────────────────────────────────────────────────────
  // category: all | cart | checkout | product | collection | other
  // sent:     all | sent | not_sent
  // active:   all | active | inactive
  const [category, setCategory] = useState('all');
  const [sent, setSent] = useState('all');
  const [active, setActive] = useState('all');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersRef = useRef(null);

  const activeFilterCount =
    (category !== 'all' ? 1 : 0) + (sent !== 'all' ? 1 : 0) + (active !== 'all' ? 1 : 0);

  useEffect(() => {
    if (!filtersOpen) return;
    const onClickOutside = (e) => {
      if (filtersRef.current && !filtersRef.current.contains(e.target)) setFiltersOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [filtersOpen]);

  const applyCategory = (val) => { setPage(1); setCategory(val); };
  const applySent = (val) => { setPage(1); setSent(val); };
  const applyActive = (val) => { setPage(1); setActive(val); };
  const clearAllFilters = () => { setPage(1); setCategory('all'); setSent('all'); setActive('all'); };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const pageIds = customers.map(c => c.id);
  const selectedOnPageCount = pageIds.filter(id => selectedIds.has(id)).length;
  const allOnPageSelected = pageIds.length > 0 && selectedOnPageCount === pageIds.length;
  const someOnPageSelected = selectedOnPageCount > 0 && !allOnPageSelected;

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someOnPageSelected;
    }
  }, [someOnPageSelected, allOnPageSelected, customers]);

  const toggleRowSelected = (row) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
    setSelectedDetails(prev => {
      const next = new Map(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.set(row.id, row);
      return next;
    });
  };

  const toggleSelectAllOnPage = () => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        pageIds.forEach(id => next.delete(id));
      } else {
        pageIds.forEach(id => next.add(id));
      }
      return next;
    });
    setSelectedDetails(prev => {
      const next = new Map(prev);
      if (allOnPageSelected) {
        pageIds.forEach(id => next.delete(id));
      } else {
        customers.forEach(row => next.set(row.id, row));
      }
      return next;
    });
  };

  const handleUnselectAll = () => {
    setSelectedIds(new Set());
    setSelectedDetails(new Map());
  };

  // ── Send Campaign dialog (UI only — no backend, no sending) ────────────
  const [sendCampaignOpen, setSendCampaignOpen] = useState(false);
  const [campaignName, setCampaignName] = useState('');
  const [campaignType, setCampaignType] = useState('promotional');

  const escapeCsvCell = (val) => {
    const s = val === null || val === undefined ? '' : String(val);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const handleExportSelected = () => {
    const rows = Array.from(selectedDetails.values());
    const header = ['id', ...COLUMNS.map(c => c.key)];
    const lines = [
      header.join(','),
      ...rows.map(row => header.map(key => escapeCsvCell(row[key])).join(',')),
    ];
    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'retarget-selected-customers.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    const ok = window.confirm(`Remove ${selectedIds.size} selected customer${selectedIds.size !== 1 ? 's' : ''} from this list?`);
    if (!ok) return;
    setCustomers(prev => prev.filter(row => !selectedIds.has(row.id)));
    setTotal(prev => Math.max(0, prev - selectedIds.size));
    setSelectedIds(new Set());
    setSelectedDetails(new Map());
  };

  const handleOpenSendCampaign = () => {
    setCampaignName('');
    setCampaignType('promotional');
    setSendCampaignOpen(true);
  };

  const handleCloseSendCampaign = () => {
    setSendCampaignOpen(false);
  };

  // Continue simply closes the dialog — no backend, no sending, no campaign is created.
  const handleContinueSendCampaign = () => {
    setSendCampaignOpen(false);
  };

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    api.retarget.list({
      search, page, limit: PAGE_SIZE,
      category: category === 'all' ? '' : category,
      sent: sent === 'all' ? '' : sent,
      active: active === 'all' ? '' : active,
    })
      .then(data => {
        setCustomers(data.rows || []);
        setTotal(data.total || 0);
      })
      .catch(() => setError('Failed to load retarget customers'))
      .finally(() => setLoading(false));
  }, [search, page, category, sent, active]);

  useEffect(() => { load(); }, [load]);

  // Debounce search input → search
  useEffect(() => {
    const t = setTimeout(() => {
      setPage(1);
      setSearch(searchInput.trim());
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  // ── File import (CSV / Excel) ──────────────────────────────────────────
  const handleFileChosen = (file) => {
    if (!file) return;
    setImportBusy(true);
    setImportError('');
    setImportResult(null);
    api.retarget.importFile(file)
      .then(result => {
        setImportResult(result);
        load();
      })
      .catch(err => setImportError(err.message || 'Import failed'))
      .finally(() => setImportBusy(false));
  };

  // ── Google Sheet connect ───────────────────────────────────────────────
  const openSheetModal = () => {
    setSheetError('');
    api.retarget.sheet.get()
      .then(settings => {
        setSheetSettings(settings);
        setSheetUrlInput(settings?.sheet_url || '');
      })
      .catch(() => {});
    setSheetModalOpen(true);
  };

  const handleConnectSheet = () => {
    if (!sheetUrlInput.trim()) { setSheetError('Enter a Google Sheet URL'); return; }
    setSheetBusy(true);
    setSheetError('');
    api.retarget.sheet.connect(sheetUrlInput.trim())
      .then(settings => {
        setSheetSettings(settings);
        setSheetModalOpen(false);
      })
      .catch(err => setSheetError(err.message || 'Failed to connect sheet'))
      .finally(() => setSheetBusy(false));
  };

  // ── Sync Now ────────────────────────────────────────────────────────────
  const handleSyncNow = () => {
    setSyncBusy(true);
    setImportError('');
    api.retarget.sheet.syncNow()
      .then(result => {
        setImportResult(result);
        load();
      })
      .catch(err => setImportError(err.message || 'Sync failed'))
      .finally(() => setSyncBusy(false));
  };

  // ── Sync History ────────────────────────────────────────────────────────
  const openHistoryModal = () => {
    setHistoryModalOpen(true);
    setHistoryLoading(true);
    api.retarget.syncHistory(20)
      .then(rows => setHistoryRows(rows || []))
      .catch(() => setHistoryRows([]))
      .finally(() => setHistoryLoading(false));
  };

  const formatDuration = (ms) => {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const formatDateTime = (v) => {
    if (!v) return '—';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '20px 24px',
        borderBottom: `1px solid ${C.border}`,
        background: C.cardBg,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Repeat size={22} color={C.text} />
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em', fontFamily: FONT }}>
                Retarget
              </h1>
              <p style={{ fontSize: 12, color: C.textMuted, margin: '4px 0 0', fontFamily: FONT }}>
                {total} retarget customer{total !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'var(--c-chatPanel)', borderRadius: 8,
            padding: '8px 12px', flex: 1, minWidth: 200, maxWidth: 400,
          }}>
            <Search size={16} color={C.textMuted} />
            <input
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search retarget customers..."
              style={{
                flex: 1, border: 'none', background: 'transparent',
                fontSize: 14, fontFamily: FONT, outline: 'none', color: C.text,
              }}
            />
          </div>

          {/* Filters */}
          <div ref={filtersRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setFiltersOpen(o => !o)}
              title="Filters"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '8px 14px', borderRadius: 8,
                border: `1px solid ${activeFilterCount > 0 ? 'var(--c-accent, #3B82F6)' : C.border}`,
                background: C.cardBg,
                cursor: 'pointer',
                fontSize: 13, fontWeight: 700, color: C.text, fontFamily: FONT,
              }}
            >
              <Filter size={15} /> Filters
              {activeFilterCount > 0 && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: 18, height: 18, borderRadius: 9, padding: '0 5px',
                  background: 'var(--c-accent, #3B82F6)', color: '#fff',
                  fontSize: 11, fontWeight: 700,
                }}>
                  {activeFilterCount}
                </span>
              )}
            </button>

            {filtersOpen && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 50,
                width: 260, background: 'var(--c-cardBg)', border: `1px solid ${C.border}`,
                borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.4)', padding: 14,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.text, fontFamily: FONT }}>Filters</span>
                  <button
                    onClick={clearAllFilters}
                    disabled={activeFilterCount === 0}
                    style={{
                      background: 'transparent', border: 'none', fontFamily: FONT,
                      fontSize: 12, fontWeight: 700, color: activeFilterCount === 0 ? C.textMuted : 'var(--c-accent, #3B82F6)',
                      cursor: activeFilterCount === 0 ? 'not-allowed' : 'pointer',
                    }}
                  >
                    All
                  </button>
                </div>

                <FilterGroup
                  label="Category"
                  value={category}
                  onChange={applyCategory}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'cart', label: 'Cart' },
                    { value: 'checkout', label: 'Checkout' },
                    { value: 'product', label: 'Product' },
                    { value: 'collection', label: 'Collection' },
                    { value: 'other', label: 'Other' },
                  ]}
                />

                <FilterGroup
                  label="Sent"
                  value={sent}
                  onChange={applySent}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'sent', label: 'Already Sent' },
                    { value: 'not_sent', label: 'Not Sent' },
                  ]}
                />

                <FilterGroup
                  label="Status"
                  value={active}
                  onChange={applyActive}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'active', label: 'Active' },
                    { value: 'inactive', label: 'Inactive' },
                  ]}
                />
              </div>
            )}
          </div>

          {/* Hidden file inputs for CSV / Excel import */}
          <input
            ref={csvInputRef} type="file" accept=".csv" style={{ display: 'none' }}
            onChange={e => { handleFileChosen(e.target.files?.[0]); e.target.value = ''; }}
          />
          <input
            ref={excelInputRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
            onChange={e => { handleFileChosen(e.target.files?.[0]); e.target.value = ''; }}
          />

          <button
            onClick={() => csvInputRef.current?.click()}
            disabled={importBusy}
            title="Import CSV"
            style={toolbarBtnStyle(importBusy)}
          >
            {importBusy ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Upload size={15} />} Import CSV
          </button>

          <button
            onClick={() => excelInputRef.current?.click()}
            disabled={importBusy}
            title="Import Excel"
            style={toolbarBtnStyle(importBusy)}
          >
            {importBusy ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <FileSpreadsheet size={15} />} Import Excel
          </button>

          <button
            onClick={openSheetModal}
            title="Connect Google Sheet"
            style={toolbarBtnStyle(false)}
          >
            <Link2 size={15} /> Connect Google Sheet
          </button>

          <button
            onClick={handleSyncNow}
            disabled={syncBusy || !sheetSettings}
            title={sheetSettings ? 'Sync Now' : 'Connect a Google Sheet first'}
            style={toolbarBtnStyle(syncBusy || !sheetSettings)}
          >
            {syncBusy ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={15} />} Sync Now
          </button>

          <button
            onClick={openHistoryModal}
            title="Sync History"
            style={toolbarBtnStyle(false)}
          >
            <History size={15} /> Sync History
          </button>
        </div>

        {/* Import / sync result banner */}
        {importResult && (
          <div style={{
            marginTop: 12, padding: '10px 14px', borderRadius: 8,
            background: 'rgba(34,197,94,0.1)', color: '#4ADE80',
            fontSize: 13, fontFamily: FONT, display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <CheckCircle2 size={16} />
            <span>
              Imported {importResult.imported ?? 0}, updated {importResult.updated ?? 0}, skipped {importResult.skipped ?? 0}
              {importResult.errors?.length ? `, ${importResult.errors.length} error(s)` : ''}.
            </span>
            <button
              onClick={() => setImportResult(null)}
              style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', color: '#4ADE80' }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {importError && (
          <div style={{
            marginTop: 12, padding: '10px 14px', borderRadius: 8,
            background: 'rgba(239,68,68,0.1)', color: '#F87171',
            fontSize: 13, fontFamily: FONT, display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <AlertCircle size={16} />
            <span>{importError}</span>
            <button
              onClick={() => setImportError('')}
              style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', color: '#F87171' }}
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {error && (
          <div style={{
            marginBottom: 12, padding: '10px 14px', borderRadius: 8,
            background: 'rgba(239,68,68,0.1)', color: '#F87171',
            fontSize: 13, fontFamily: FONT,
          }}>
            {error}
          </div>
        )}

        {loading && customers.length === 0 && (
          <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 13, padding: 40 }}>
            <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', margin: '0 auto 8px' }} />
            Loading retarget customers...
          </div>
        )}

        {!loading && customers.length === 0 && !error && (
          <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 13, padding: 60 }}>
            <Inbox size={40} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
            <div>
              {search || activeFilterCount > 0
                ? 'No retarget customers match your search/filters'
                : 'No retarget customers yet'}
            </div>
          </div>
        )}

        {selectedIds.size > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexWrap: 'wrap', gap: 10,
            marginBottom: 12, padding: '10px 14px', borderRadius: 10,
            border: `1px solid ${C.border}`, background: 'var(--c-hover)',
            fontFamily: FONT,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
              Selected Customers: {selectedIds.size}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={handleExportSelected} style={secondaryBtnStyle}>
                Export
              </button>
              <button
                onClick={handleDeleteSelected}
                style={{
                  ...secondaryBtnStyle,
                  color: '#F87171',
                  borderColor: 'rgba(239,68,68,0.4)',
                }}
              >
                Delete
              </button>
              <button onClick={handleUnselectAll} style={secondaryBtnStyle}>
                Clear Selection
              </button>
              <button onClick={handleOpenSendCampaign} style={primaryBtnStyle(false)}>
                Send Campaign
              </button>
            </div>
          </div>
        )}

        {customers.length > 0 && (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--c-hover)' }}>
                  <th style={{
                    padding: '12px 16px', textAlign: 'left', fontWeight: 600,
                    color: C.textSecondary, borderBottom: `1px solid ${C.border}`,
                    width: 36,
                  }}>
                    <input
                      ref={headerCheckboxRef}
                      type="checkbox"
                      checked={allOnPageSelected}
                      onChange={toggleSelectAllOnPage}
                      title={allOnPageSelected ? 'Unselect all on this page' : 'Select all on this page'}
                      style={{ cursor: 'pointer', width: 15, height: 15 }}
                    />
                  </th>
                  {COLUMNS.map(col => (
                    <th key={col.key} style={{
                      padding: '12px 16px', textAlign: 'left', fontWeight: 600,
                      color: C.textSecondary, borderBottom: `1px solid ${C.border}`,
                      whiteSpace: 'nowrap',
                    }}>
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {customers.map(row => {
                  const checked = selectedIds.has(row.id);
                  return (
                    <tr
                      key={row.id}
                      style={{ background: checked ? 'var(--c-hover)' : C.cardBg, borderBottom: `1px solid ${C.border}` }}
                      onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'var(--c-rowHover)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = checked ? 'var(--c-hover)' : C.cardBg; }}
                    >
                      <td style={{ padding: '12px 16px', width: 36 }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleRowSelected(row)}
                          style={{ cursor: 'pointer', width: 15, height: 15 }}
                        />
                      </td>
                      {COLUMNS.map(col => (
                        <td key={col.key} style={{
                          padding: '12px 16px',
                          color: col.key === 'name' ? C.text : C.textSecondary,
                          fontWeight: col.key === 'name' ? 600 : 400,
                          maxWidth: col.key === 'exit_url' ? 260 : undefined,
                          overflow: col.key === 'exit_url' ? 'hidden' : undefined,
                          textOverflow: col.key === 'exit_url' ? 'ellipsis' : undefined,
                          whiteSpace: col.key === 'exit_url' ? 'nowrap' : undefined,
                        }}>
                          {formatCell(col.key, row[col.key])}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {total > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginTop: 16, fontFamily: FONT,
          }}>
            <div style={{ fontSize: 12, color: C.textMuted }}>
              Page {page} of {totalPages} &middot; {total} total
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '6px 10px', borderRadius: 8,
                  border: `1px solid ${C.border}`, background: C.cardBg,
                  color: page <= 1 ? C.textMuted : C.text,
                  cursor: page <= 1 ? 'not-allowed' : 'pointer',
                  fontSize: 12, fontWeight: 600, opacity: page <= 1 ? 0.5 : 1,
                }}
              >
                <ChevronLeft size={14} /> Prev
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '6px 10px', borderRadius: 8,
                  border: `1px solid ${C.border}`, background: C.cardBg,
                  color: page >= totalPages ? C.textMuted : C.text,
                  cursor: page >= totalPages ? 'not-allowed' : 'pointer',
                  fontSize: 12, fontWeight: 600, opacity: page >= totalPages ? 0.5 : 1,
                }}
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Connect Google Sheet modal ────────────────────────────────── */}
      {sheetModalOpen && (
        <div style={overlayStyle} onClick={() => setSheetModalOpen(false)}>
          <div style={modalStyle} onClick={e => e.stopPropagation()}>
            <div style={modalHeaderStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Link2 size={17} color={C.text} />
                <h2 style={modalTitleStyle}>Connect Google Sheet</h2>
              </div>
              <button onClick={() => setSheetModalOpen(false)} style={iconBtnStyle}><X size={16} /></button>
            </div>

            <p style={{ fontSize: 12, color: C.textMuted, fontFamily: FONT, margin: '0 0 12px' }}>
              Paste a public Google Sheet URL ("Anyone with the link can view"). Expected columns:
              Name, Phone, Email, Exit URL, Retarget Type (optional), Timestamp (optional).
            </p>

            <input
              value={sheetUrlInput}
              onChange={e => setSheetUrlInput(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              style={{
                width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8,
                border: `1px solid ${C.border}`, background: 'var(--c-chatPanel)', color: C.text,
                fontSize: 13, fontFamily: FONT, outline: 'none',
              }}
            />

            {sheetSettings?.last_synced_at && (
              <p style={{ fontSize: 11, color: C.textMuted, fontFamily: FONT, margin: '10px 0 0' }}>
                Last synced {formatDateTime(sheetSettings.last_synced_at)}
              </p>
            )}
            {sheetSettings?.last_error_message && (
              <p style={{ fontSize: 11, color: '#F87171', fontFamily: FONT, margin: '6px 0 0' }}>
                Last error: {sheetSettings.last_error_message}
              </p>
            )}
            {sheetError && (
              <p style={{ fontSize: 12, color: '#F87171', fontFamily: FONT, margin: '10px 0 0' }}>{sheetError}</p>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button onClick={() => setSheetModalOpen(false)} style={secondaryBtnStyle}>Cancel</button>
              <button onClick={handleConnectSheet} disabled={sheetBusy} style={primaryBtnStyle(sheetBusy)}>
                {sheetBusy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Link2 size={14} />}
                {sheetBusy ? 'Connecting...' : 'Connect'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Sync History modal ────────────────────────────────────────── */}
      {historyModalOpen && (
        <div style={overlayStyle} onClick={() => setHistoryModalOpen(false)}>
          <div style={{ ...modalStyle, maxWidth: 720 }} onClick={e => e.stopPropagation()}>
            <div style={modalHeaderStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <History size={17} color={C.text} />
                <h2 style={modalTitleStyle}>Sync History</h2>
              </div>
              <button onClick={() => setHistoryModalOpen(false)} style={iconBtnStyle}><X size={16} /></button>
            </div>

            {historyLoading && (
              <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 13, padding: 30 }}>
                <Loader2 size={18} style={{ animation: 'spin 1s linear infinite', margin: '0 auto 8px' }} />
                Loading sync history...
              </div>
            )}

            {!historyLoading && historyRows.length === 0 && (
              <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 13, padding: 30 }}>
                No sync runs yet.
              </div>
            )}

            {!historyLoading && historyRows.length > 0 && (
              <div style={{ maxHeight: 420, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 8 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--c-hover)' }}>
                      {['Source', 'Start', 'End', 'Duration', 'Imported', 'Updated', 'Skipped', 'Errors', 'Status'].map(h => (
                        <th key={h} style={{
                          padding: '10px 12px', textAlign: 'left', fontWeight: 600,
                          color: C.textSecondary, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap',
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {historyRows.map(row => (
                      <tr key={row.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                        <td style={historyCellStyle}>{row.source}</td>
                        <td style={historyCellStyle}>{formatDateTime(row.started_at)}</td>
                        <td style={historyCellStyle}>{formatDateTime(row.finished_at)}</td>
                        <td style={historyCellStyle}>{formatDuration(row.duration_ms)}</td>
                        <td style={historyCellStyle}>{row.rows_imported}</td>
                        <td style={historyCellStyle}>{row.rows_updated}</td>
                        <td style={historyCellStyle}>{row.rows_skipped}</td>
                        <td style={{ ...historyCellStyle, color: row.rows_errored > 0 ? '#F87171' : C.textSecondary }}>
                          {row.rows_errored}
                        </td>
                        <td style={{
                          ...historyCellStyle,
                          color: row.status === 'success' ? '#4ADE80' : row.status === 'error' ? '#F87171' : C.textMuted,
                          fontWeight: 600,
                        }}>
                          {row.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
      {/* ── Send Campaign dialog (UI only — no backend, no sending) ────── */}
      {sendCampaignOpen && (
        <div style={overlayStyle} onClick={handleCloseSendCampaign}>
          <div style={{ ...modalStyle, maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div style={modalHeaderStyle}>
              <h2 style={modalTitleStyle}>Send Campaign</h2>
              <button onClick={handleCloseSendCampaign} style={iconBtnStyle}><X size={16} /></button>
            </div>

            {/* Selected Customers */}
            <div style={{ marginBottom: 16 }}>
              <label style={fieldLabelStyle}>Selected Customers</label>
              <div style={{
                padding: '10px 12px', borderRadius: 8,
                border: `1px solid ${C.border}`, background: 'var(--c-chatPanel)',
                color: C.text, fontSize: 13, fontFamily: FONT, fontWeight: 600,
              }}>
                {selectedIds.size} customer{selectedIds.size !== 1 ? 's' : ''} selected
              </div>
            </div>

            {/* Campaign Name */}
            <div style={{ marginBottom: 16 }}>
              <label style={fieldLabelStyle}>Campaign Name</label>
              <input
                value={campaignName}
                onChange={e => setCampaignName(e.target.value)}
                placeholder="e.g. Cart Abandonment Winback"
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8,
                  border: `1px solid ${C.border}`, background: 'var(--c-chatPanel)', color: C.text,
                  fontSize: 13, fontFamily: FONT, outline: 'none',
                }}
              />
            </div>

            {/* Campaign Type */}
            <div style={{ marginBottom: 16 }}>
              <label style={fieldLabelStyle}>Campaign Type</label>
              <select
                value={campaignType}
                onChange={e => setCampaignType(e.target.value)}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8,
                  border: `1px solid ${C.border}`, background: 'var(--c-chatPanel)', color: C.text,
                  fontSize: 13, fontFamily: FONT, outline: 'none',
                }}
              >
                <option value="promotional">Promotional</option>
                <option value="cart_recovery">Cart Recovery</option>
                <option value="checkout_recovery">Checkout Recovery</option>
                <option value="reengagement">Re-engagement</option>
                <option value="announcement">Announcement</option>
              </select>
            </div>

            {/* Template placeholder */}
            <div style={{ marginBottom: 16 }}>
              <label style={fieldLabelStyle}>Template</label>
              <div style={{
                padding: '16px', borderRadius: 8,
                border: `1px dashed ${C.border}`, background: 'var(--c-chatPanel)',
                color: C.textMuted, fontSize: 12, fontFamily: FONT, textAlign: 'center',
              }}>
                Template selection coming soon
              </div>
            </div>

            {/* Preview placeholder */}
            <div style={{ marginBottom: 20 }}>
              <label style={fieldLabelStyle}>Preview</label>
              <div style={{
                padding: '16px', borderRadius: 8,
                border: `1px dashed ${C.border}`, background: 'var(--c-chatPanel)',
                color: C.textMuted, fontSize: 12, fontFamily: FONT, textAlign: 'center',
              }}>
                Message preview coming soon
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={handleCloseSendCampaign} style={secondaryBtnStyle}>Cancel</button>
              <button onClick={handleContinueSendCampaign} style={primaryBtnStyle(false)}>Continue</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Filter dropdown group (single-select pill list) ────────────────────
function FilterGroup({ label, value, onChange, options }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{
        fontSize: 10, fontWeight: 700, color: C.textMuted, fontFamily: FONT,
        textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6,
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {options.map(opt => {
          const selected = value === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              style={{
                padding: '5px 10px', borderRadius: 999,
                border: `1px solid ${selected ? 'var(--c-accent, #3B82F6)' : C.border}`,
                background: selected ? 'var(--c-accent, #3B82F6)' : 'transparent',
                color: selected ? '#fff' : C.textSecondary,
                fontSize: 12, fontWeight: 600, fontFamily: FONT, cursor: 'pointer',
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Shared inline styles ─────────────────────────────────────────────────
function toolbarBtnStyle(disabled) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 14px', borderRadius: 8,
    border: `1px solid ${C.border}`, background: C.cardBg,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
    fontSize: 13, fontWeight: 700, color: C.text, fontFamily: FONT,
  };
}

function primaryBtnStyle(disabled) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 16px', borderRadius: 8, border: 'none',
    background: disabled ? 'var(--c-accentMuted, #3B82F6)' : 'var(--c-accent, #3B82F6)',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.7 : 1,
    fontSize: 13, fontWeight: 700, color: '#fff', fontFamily: FONT,
  };
}

const secondaryBtnStyle = {
  padding: '8px 16px', borderRadius: 8,
  border: `1px solid ${C.border}`, background: C.cardBg,
  cursor: 'pointer', fontSize: 13, fontWeight: 700, color: C.text, fontFamily: FONT,
};

const iconBtnStyle = {
  background: 'transparent', border: 'none', cursor: 'pointer',
  color: C.textMuted, padding: 4, display: 'flex',
};

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};

const modalStyle = {
  width: '90%', maxWidth: 480, background: 'var(--c-cardBg)',
  border: `1px solid ${C.border}`, borderRadius: 12, padding: 20,
  boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
};

const modalHeaderStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12,
};

const modalTitleStyle = {
  fontSize: 16, fontWeight: 700, color: C.text, margin: 0, fontFamily: FONT,
};

const fieldLabelStyle = {
  display: 'block', fontSize: 11, fontWeight: 700, color: C.textMuted, fontFamily: FONT,
  textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6,
};

const historyCellStyle = {
  padding: '9px 12px', color: C.textSecondary, whiteSpace: 'nowrap',
};

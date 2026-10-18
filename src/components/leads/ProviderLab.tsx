import React from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FlaskConical, GripVertical, Loader2, RotateCcw, Save, AlertTriangle } from 'lucide-react';
import {
  getProviderStats,
  getWaterfall,
  setWaterfall,
  providerStyle,
  type ProviderStat,
} from '../../lib/leads';
import { DEFAULT_EMAIL_ORDER } from '../../lib/leads';
import { formatUsd } from '../../lib/billing';
import { Screen, Panel, Button, Segmented, Figure } from './Screen';

/**
 * Which provider is worth its place, and in what order.
 *
 * The paragraph this replaces said the screen would let you "see which actually
 * finds the most for what it costs". It does, from your own history rather than
 * a benchmark: the numbers below are every attempt this workspace has made,
 * across every run.
 *
 * The ranking is by cost per independent find, not by price and not by hit rate,
 * and the distinction is the entire reason the screen is worth having. A provider
 * that charges $0.005 and hits 20% of the time costs more per address delivered
 * than one that charges $0.0089 and hits 80%. Every user pays that arithmetic
 * inside the waterfall without ever seeing it written down, and this is where it
 * becomes visible.
 *
 * "Independent" is doing real work in that sentence. A provider that re-finds an
 * address Kitt already found is not earning its slot in the chain, so the count
 * that matters is attempts that supplied something nobody else had.
 */

type Mode = 'default' | 'custom';

export const ProviderLab: React.FC = () => {
  const [stats, setStats] = React.useState<ProviderStat[] | null>(null);
  const [order, setOrder] = React.useState<string[]>([...DEFAULT_EMAIL_ORDER]);
  const [mode, setMode] = React.useState<Mode>('default');
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [s, w] = await Promise.all([getProviderStats('email'), getWaterfall('email')]);
      if (cancelled) return;
      setStats(s?.providers ?? []);
      if (w.order && w.order.length) {
        setOrder(w.order);
        setMode('custom');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Keyboard reordering, not just pointer. Drag-only ordering is unreachable
    // for somebody using a keyboard, and the control it reorders is the one that
    // decides what the user pays.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byId = React.useMemo(() => {
    const m = new Map<string, ProviderStat>();
    for (const p of stats ?? []) m.set(p.endpoint_id, p);
    return m;
  }, [stats]);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setOrder((prev) => {
      const next = arrayMove(prev, prev.indexOf(String(active.id)), prev.indexOf(String(over.id)));
      setMode('custom');
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      // Default means "send no order at all" rather than "send the default
      // order". Storing the default as a custom order would freeze it, and the
      // next provider added to the registry would be invisible to this user
      // forever.
      const res = await setWaterfall('email', mode === 'custom' ? order : []);
      if (!res.ok) {
        setError(res.error ?? 'Could not save the order.');
        return;
      }
      setNotice('Order saved. New runs will use it from their next chunk.');
    } catch {
      setError('Could not save the order.');
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setOrder([...DEFAULT_EMAIL_ORDER]);
    setMode('default');
    setNotice(null);
    setError(null);
  };

  // What the reorder is worth, in the only terms that mean something: moving the
  // provider that has actually been finding things to the front.
  const worth = React.useMemo(() => {
    if (mode !== 'custom') return null;
    const defaultOrder = DEFAULT_EMAIL_ORDER;
    const ranked = [...order].filter((id) => byId.get(id)?.cost_per_find != null);
    if (ranked.length === 0) return null;

    let better = 0;
    for (const id of ranked) {
      const currentAt = order.indexOf(id);
      const wasAt = defaultOrder.indexOf(id);
      if (currentAt < wasAt) better++;
    }
    if (better === 0) return null;

    const cheapest = Math.min(...ranked.map((id) => byId.get(id)!.cost_per_find!));
    const dearest = Math.max(...order.map((id) => byId.get(id)?.cost_per_find ?? Infinity));
    const saving = dearest === Infinity || cheapest === dearest ? null : dearest - cheapest;
    return { better, saving };
  }, [order, mode, byId]);

  const totalCost = (stats ?? []).reduce((n, p) => n + p.cost_usd, 0);
  const totalAttempts = (stats ?? []).reduce((n, p) => n + p.attempts, 0);
  const totalFinds = (stats ?? []).reduce((n, p) => n + p.first_to_find, 0);

  return (
    <Screen
      title="Provider lab"
      subtitle="Every attempt this workspace has made, across every run. Drag to reorder what runs next."
      icon={<FlaskConical className="w-4 h-4" />}
      action={
        <Segmented
          value={mode}
          onChange={(v) => {
            if (v === 'default') reset();
          }}
          options={[
            { value: 'default', label: 'Default', title: 'Cheapest first, as shipped' },
            { value: 'custom', label: 'Custom', title: 'Your order' },
          ]}
        />
      }
    >
      {stats === null ? (
        <div className="py-20 flex justify-center">
          <Loader2 className="w-4 h-4 animate-spin text-[#b5b5ad]" />
        </div>
      ) : (
        <>
          <Panel label="Your spend">
            <div className="flex gap-10 flex-wrap">
              <Figure label="Provider calls" value={totalAttempts.toLocaleString()} size="sm" />
              <Figure
                label="Addresses found"
                value={totalFinds.toLocaleString()}
                size="sm"
                tone={totalFinds > 0 ? 'good' : 'default'}
              />
              <Figure label="Spent at providers" value={formatUsd(totalCost)} size="sm" />
              <Figure
                label="Cost per find"
                value={totalFinds > 0 ? formatUsd(totalCost / totalFinds) : '—'}
                size="sm"
                sub={totalFinds > 0 ? 'across everything tried' : 'nothing found yet'}
              />
            </div>
          </Panel>

          {totalAttempts === 0 && (
            <div className="flex items-start gap-2 px-4 py-3 bg-[#fdf6ec] border border-[#e8d9bd]">
              <AlertTriangle className="w-3.5 h-3.5 text-[#b45309] mt-0.5 flex-shrink-0" />
              <p className="text-xs font-mono text-[#b45309] leading-relaxed">
                Nothing has been tried yet, so there is nothing to compare. These are the shipped
                prices; the rates fill in after your first run.
              </p>
            </div>
          )}

          <Panel
            label={`Waterfall order · ${mode === 'custom' ? 'yours' : 'shipped'}`}
            aside={
              <div className="flex items-center gap-3">
                {worth && (
                  <span className="text-[10px] font-mono text-[#1a7f4b]">
                    {worth.better} moved up
                    {worth.saving !== null && ` · ${formatUsd(worth.saving)} apart at the extremes`}
                  </span>
                )}
                {mode === 'custom' && (
                  <>
                    <button
                      onClick={reset}
                      className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] hover:text-[#141414] transition-colors cursor-pointer flex items-center gap-1.5"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Reset
                    </button>
                    <Button onClick={() => void save()} disabled={saving} className="!py-1 !px-2.5 !text-[10px]">
                      {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                      Save
                    </Button>
                  </>
                )}
              </div>
            }
          >
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={order} strategy={verticalListSortingStrategy}>
                <ul className="-mx-2">
                  {order.map((id, i) => (
                    <Row
                      key={id}
                      id={id}
                      position={i + 1}
                      stat={byId.get(id)}
                      draggable={mode === 'custom'}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>

            <p className="text-[10px] font-mono text-[#8a8a86] leading-relaxed mt-4 pt-4 border-t border-[#eeeeea]">
              The waterfall stops at each provider&apos;s own success price, so a miss costs
              whatever the provider charges for a miss. Prices are what was last set in the
              catalogue and have not been confirmed against a live response yet.
            </p>
          </Panel>

          {error && (
            <div className="px-4 py-3 bg-[#fdf2f2] border border-[#f0c4c4] text-xs font-mono text-[#8a2a2a]">
              {error}
            </div>
          )}
          {notice && (
            <div className="px-4 py-3 bg-[#f6f6f4] border border-[#e3e3de] text-xs font-mono text-[#4a4a47]">
              {notice}
            </div>
          )}
        </>
      )}
    </Screen>
  );
};

// ---------------------------------------------------------------------------
// One provider
// ---------------------------------------------------------------------------

const Row: React.FC<{
  id: string;
  position: number;
  stat: ProviderStat | undefined;
  draggable: boolean;
}> = ({ id, position, stat, draggable }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !draggable });
  const style = providerStyle(id);

  const rate = stat?.hit_rate ?? null;
  const noHistory = !stat || stat.attempts === 0;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-3 px-2 h-14 border-b border-[#eeeeea] last:border-b-0 ${
        isDragging ? 'bg-[#f6f6f4] relative z-10' : ''
      }`}
    >
      <div
        {...attributes}
        {...listeners}
        className={draggable ? 'cursor-grab active:cursor-grabbing text-[#b5b5ad] hover:text-[#8a8a86] touch-none p-1 -m-1' : 'p-1 -m-1 text-transparent'}
        aria-label={draggable ? `Reorder ${providerStyle(id).label}` : undefined}
      >
        <GripVertical className="w-3.5 h-3.5" />
      </div>

      <span className="text-[10px] font-mono text-[#b5b5ad] w-4 tabular-nums text-right flex-shrink-0">
        {position}
      </span>

      <span
        className={`inline-flex items-center gap-1.5 px-2 py-1 text-[10px] font-mono uppercase tracking-wider flex-shrink-0 ${style.chip} ${style.ink}`}
      >
        {providerStyle(id).label}
      </span>

      <span className="text-[10px] font-mono text-[#8a8a86] tabular-nums w-16 flex-shrink-0">
        {formatUsd(stat?.price_usd ?? 0)}
      </span>

      <div className="flex-1 min-w-0 flex items-center gap-3">
        {noHistory ? (
          <span className="text-[10px] font-mono text-[#d5d5cf]">never tried</span>
        ) : (
          <>
            {/* The rate as a bar rather than a percentage alone. Two providers at
                20% and 80% are far less distinguishable as digits at a glance
                than as two lengths, and the comparison is the reason to open
                this screen. */}
            <div className="flex-1 max-w-[140px] h-1 bg-[#eeeeea]">
              <div
                className="h-full transition-[width] duration-500"
                style={{
                  width: `${(rate ?? 0) * 100}%`,
                  backgroundColor: rate !== null && rate >= 0.6 ? '#1a7f4b' : rate !== null && rate >= 0.3 ? '#b45309' : '#b03a20',
                }}
              />
            </div>
            <span className="text-[10px] font-mono text-[#4a4a47] tabular-nums w-9 flex-shrink-0">
              {Math.round((rate ?? 0) * 100)}%
            </span>
          </>
        )}
      </div>

      <div className="w-40 text-right flex-shrink-0">
        {stat && stat.cost_per_find !== null ? (
          <>
            <span className="block text-[11px] font-mono text-[#141414] tabular-nums">
              {formatUsd(stat.cost_per_find)}
            </span>
            <span className="block text-[9px] font-mono text-[#b5b5ad]">per find</span>
          </>
        ) : (
          <span className="text-[10px] font-mono text-[#d5d5cf]">
            {noHistory ? '—' : `${formatUsd(stat.cost_usd)} spent`}
          </span>
        )}
      </div>
    </li>
  );
};
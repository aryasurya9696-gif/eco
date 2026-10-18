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
import type { LeadStep } from '../../types';
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

/**
 * Which step the lab is looking at.
 *
 * The lab was built for the address waterfall and hardcoded to it, which was
 * defensible when that was the only waterfall a run used. It is not any more: a
 * find run looks up the decision maker first, and that step decides who gets
 * contacted and costs a fifth of a credit a row. A screen that shows the cost
 * of every provider a run touches, except the one that chooses the person, is
 * the screen a user trusts least exactly when they need it.
 *
 * Company first, because it decides the shape of the run and everything after
 * it works on whatever it produced. Phone last, because it is opt-in and the
 * only one a run may not perform at all.
 */
const STEPS: Array<{ value: LeadStep; label: string; blurb: string }> = [
  {
    value: 'company',
    label: 'Companies',
    blurb: 'Finds the companies the search is about. A run does this once, at the start.',
  },
  {
    value: 'person',
    label: 'Decision makers',
    blurb: 'Finds who to contact at each company, and ranks them against the titles you asked for.',
  },
  {
    value: 'email',
    label: 'Addresses',
    blurb: 'Finds an address for the person. The waterfall every row goes through.',
  },
  {
    value: 'verify',
    label: 'Verification',
    blurb: 'Checks whether an address is a real mailbox. Only the clean modes run this.',
  },
  {
    value: 'enrich',
    label: 'Company details',
    blurb: "Adds the company's own details. Only the full-enrich mode runs this.",
  },
  {
    value: 'phone',
    label: 'Phone numbers',
    blurb: 'Finds a direct number. The most expensive step by a wide margin, and opt-in per run.',
  },
];

export const ProviderLab: React.FC = () => {
  const [step, setStep] = React.useState<LeadStep>('email');
  const [stats, setStats] = React.useState<ProviderStat[] | null>(null);
  const [order, setOrder] = React.useState<string[]>([]);
  const [shipped, setShipped] = React.useState<string[]>([]);
  const [mode, setMode] = React.useState<Mode>('default');
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const stepInfo = STEPS.find((s) => s.value === step);

  React.useEffect(() => {
    let cancelled = false;
    // Cleared first, so switching steps shows the loader rather than the previous
    // step's numbers sitting under the new step's label for the length of a call.
    setStats(null);
    setNotice(null);
    setError(null);
    setMode('default');
    void (async () => {
      const [s, w] = await Promise.all([getProviderStats(step), getWaterfall(step)]);
      if (cancelled) return;
      setStats(s?.providers ?? []);
      setShipped(w.defaultOrder);
      setOrder(w.effectiveOrder.length ? w.effectiveOrder : w.defaultOrder);
      if (w.order && w.order.length) setMode('custom');
    })();
    return () => {
      cancelled = true;
    };
  }, [step]);

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
      const res = await setWaterfall(step, mode === 'custom' ? order : []);
      if (!res.ok) {
        setError(res.error ?? 'Could not save the order.');
        return;
      }
      setNotice(`Order saved. New runs will use it from their next chunk.`);
    } catch {
      setError('Could not save the order.');
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setOrder([...shipped]);
    setMode('default');
    setNotice(null);
    setError(null);
  };

  // What the reorder is worth, in the only terms that mean something: moving the
  // provider that has actually been finding things to the front.
  const worth = React.useMemo(() => {
    if (mode !== 'custom') return null;
    const ranked = [...order].filter((id) => byId.get(id)?.cost_per_find != null);
    if (ranked.length === 0) return null;

    let better = 0;
    for (const id of ranked) {
      const currentAt = order.indexOf(id);
      const wasAt = shipped.indexOf(id);
      if (wasAt === -1) continue;
      if (currentAt < wasAt) better++;
    }
    if (better === 0) return null;

    const cheapest = Math.min(...ranked.map((id) => byId.get(id)!.cost_per_find!));
    const dearest = Math.max(...order.map((id) => byId.get(id)?.cost_per_find ?? Infinity));
    const saving = dearest === Infinity || cheapest === dearest ? null : dearest - cheapest;
    return { better, saving };
  }, [order, mode, byId, shipped]);

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
      <Panel label="Which step">
        <div className="flex flex-wrap gap-1.5">
          {STEPS.map((s) => (
            <button
              key={s.value}
              onClick={() => setStep(s.value)}
              title={s.blurb}
              className={`px-2.5 py-1 text-[10px] font-mono rounded-none transition-colors cursor-pointer ${
                step === s.value
                  ? 'bg-[#141414] text-white'
                  : 'border border-[#e3e3de] text-[#8a8a86] hover:border-[#141414] hover:text-[#141414]'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {stepInfo && (
          <p className="text-[10px] font-mono text-[#8a8a86] leading-relaxed mt-2.5">{stepInfo.blurb}</p>
        )}
      </Panel>

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
                label="Finds that mattered"
                value={totalFinds.toLocaleString()}
                size="sm"
                sub={step === 'verify' ? 'a real mailbox' : 'supplied by nobody else'}
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
            label={`${stepInfo?.label ?? 'Waterfall'} · ${mode === 'custom' ? 'your order' : 'shipped order'}`}
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
            {/* Nothing to drag. Say so rather than drawing an empty panel, which
                reads as a broken screen rather than a step with no providers. */}
            {order.length === 0 ? (
              <p className="text-xs font-mono text-[#8a8a86] leading-relaxed py-4">
                No providers are registered for this step.
              </p>
            ) : (
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
            )}

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
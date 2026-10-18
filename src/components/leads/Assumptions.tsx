import React from 'react';
import { AlertTriangle, Info, CheckCircle2 } from 'lucide-react';
import type { LeadIcpDocument } from '../../types';
import { Panel } from './Screen';

/**
 * What the generator guessed, and how much a wrong guess would cost.
 *
 * The AI has been writing an assumptions list since the first version and the app
 * has never shown it. That is the wrong way round: a profile written from a
 * website is a set of inferences, and the user is about to pay real money per
 * lookup on the strength of them. Saying nothing is not neutrality — it is the
 * appearance of having considered it.
 *
 * The severity is what makes the panel worth reading. An assumptions list where
 * every item is styled identically is a list nobody scans, because three of the
 * ten things in it will matter and the other seven will not, and nothing on
 * screen distinguishes them. Ranked, the top of the panel is the part that changes
 * what the search finds.
 *
 * Severity is about consequence, not certainty. "We guessed UK" is high even
 * though we are fairly sure, because being fairly sure about the wrong country
 * sends the whole run at the wrong people.
 */

export interface Assumption {
  text: string;
  severity?: 'high' | 'medium' | 'low';
  why?: string;
  /** A stored profile from before the shape change is a bare string. */
  text_only?: boolean;
}

const SEVERITY: Record<
  NonNullable<Assumption['severity']>,
  { label: string; icon: React.ReactNode; row: string; chip: string }
> = {
  high: {
    label: 'Check this',
    icon: <AlertTriangle className="w-3 h-3" />,
    row: 'border-[#f0cfc8] bg-[#fdf1ee]',
    chip: 'text-[#b03a20]',
  },
  medium: {
    label: 'Worth knowing',
    icon: <Info className="w-3 h-3" />,
    row: 'border-[#e8d9bd] bg-[#fdf6ec]',
    chip: 'text-[#b45309]',
  },
  low: {
    label: 'Fine detail',
    icon: <CheckCircle2 className="w-3 h-3" />,
    row: 'border-[#eeeeea] bg-white',
    chip: 'text-[#8a8a86]',
  },
};

const RANK = { high: 0, medium: 1, low: 2 } as const;

export const AssumptionPanel: React.FC<{
  doc: Pick<LeadIcpDocument, 'assumptions' | 'confidence'> | null | undefined;
  /** True while the profile is being read, so the panel is not drawn empty. */
  loading?: boolean;
}> = ({ doc }) => {
  const raw = doc?.assumptions ?? [];

  // A stored profile written before the shape change is an array of bare strings.
  // Rendering those as-is would show every one of them at the same weight, which is
  // the exact problem the severities were added to solve.
  const items: Assumption[] = (raw as unknown[])
    .map((a) =>
      typeof a === 'string'
        ? { text: a, severity: 'medium' as const }
        : (a as Assumption),
    )
    .filter((a) => a && typeof a.text === 'string' && a.text.trim() !== '');

  if (items.length === 0) return null;

  const sorted = [...items].sort(
    (a, b) => RANK[a.severity ?? 'medium'] - RANK[b.severity ?? 'medium'],
  );
  const highs = sorted.filter((a) => (a.severity ?? 'medium') === 'high').length;

  const confidence = doc?.confidence;

  return (
    <Panel
      label="What we assumed"
      hint={
        highs > 0
          ? `${highs} of these would change who you are searching for.`
          : 'Nothing here is load-bearing, but it is what we worked from.'
      }
      aside={
        confidence !== undefined && (
          <span
            className="text-[10px] font-mono text-[#8a8a86] tabular-nums flex-shrink-0"
            title="How sure the generator is about the profile as a whole. It is a self-assessment and is worth less on its own than the list below."
          >
            confidence {Math.round(confidence * 100)}%
          </span>
        )
      }
    >
      <ul className="space-y-2">
        {sorted.map((a, i) => {
          const sev = SEVERITY[a.severity ?? 'medium'];
          return (
            <li key={`${a.text}-${i}`} className={`border px-3 py-2.5 ${sev.row}`}>
              <div className="flex items-start gap-2.5">
                <span className={`mt-0.5 flex-shrink-0 ${sev.chip}`}>{sev.icon}</span>

                <div className="min-w-0 flex-1">
                  <p className="text-xs font-mono text-[#141414] leading-relaxed">{a.text}</p>
                  {a.why && (
                    <p className="text-[11px] font-mono text-[#8a8a86] leading-relaxed mt-1">
                      {a.why}
                    </p>
                  )}
                </div>

                <span
                  className={`text-[9px] font-mono uppercase tracking-wider whitespace-nowrap flex-shrink-0 mt-0.5 ${sev.chip}`}
                >
                  {sev.label}
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="text-[10px] font-mono text-[#8a8a86] leading-relaxed mt-4 pt-3 border-t border-[#eeeeea]">
        Change anything above and the search uses your version, not this one. Nothing here costs
        anything on its own.
      </p>
    </Panel>
  );
};
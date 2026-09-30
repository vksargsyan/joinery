import {
  formatPlanNumber,
  formatPlanTime,
  type BufferCounts,
  type PlanModel,
  type PlanRow,
} from '../../state/explain/model';

/**
 * The details pane of the visual explain: every figure of the selected plan node — costs, row
 * estimate and actuals per loop and in total, times, loops, buffers — then everything else the
 * server reported for it (filters, sort keys, join conditions, workers...).
 */

const BUFFER_LABELS: readonly [keyof BufferCounts, string][] = [
  ['sharedHit', 'Shared hit'],
  ['sharedRead', 'Shared read'],
  ['sharedDirtied', 'Shared dirtied'],
  ['sharedWritten', 'Shared written'],
  ['localHit', 'Local hit'],
  ['localRead', 'Local read'],
  ['tempRead', 'Temp read'],
  ['tempWritten', 'Temp written'],
];

export function PlanDetails(props: { readonly row: PlanRow; readonly model: PlanModel }) {
  const { row, model } = props;
  const { node } = row;
  const number = (value: number | undefined): string | undefined =>
    value === undefined ? undefined : formatPlanNumber(value);
  const time = (value: number | undefined): string | undefined =>
    value === undefined ? undefined : formatPlanTime(value);
  const figures: [string, string | undefined][] = [
    ['Relation', node.relation],
    ['Index', node.index],
    ['Startup cost', number(node.startupCost)],
    ['Total cost', number(node.totalCost)],
    ['Own cost', number(row.selfCost)],
    ['Estimated rows (per loop)', number(node.estimatedRows)],
    ['Actual rows (per loop)', number(node.actualRows)],
    ['Loops', number(node.loops)],
    ['Rows (all loops)', model.analyzed ? number(row.totalRows) : undefined],
    ['Time (per loop)', time(node.actualTimeMs)],
    ['Time (all loops)', time(row.totalTimeMs)],
    ['Own time', time(row.selfTimeMs)],
    [
      'Row estimate',
      row.misestimate
        ? `${formatPlanNumber(Math.round(row.misestimate.factor))}× ${
            row.misestimate.direction === 'under' ? 'too low' : 'too high'
          }`
        : undefined,
    ],
    ...BUFFER_LABELS.map(([key, label]): [string, string | undefined] => [
      `${label} blocks`,
      number(row.buffers?.[key]),
    ]),
  ];
  const detail = Object.entries(node.detail)
    .filter(([key]) => !IN_FIGURES.has(key))
    .sort(([a], [b]) => a.localeCompare(b));
  return (
    <aside
      aria-label="Plan node details"
      data-testid="plan-details"
      className="w-80 shrink-0 overflow-auto border-l border-border bg-panel p-2"
    >
      <h3 className="mb-2 font-mono text-[13px] font-semibold">{node.operation}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {figures
          .filter(([, value]) => value !== undefined)
          .map(([label, value]) => (
            <Pair key={label} label={label} value={value!} />
          ))}
      </dl>
      {detail.length > 0 && (
        <>
          <h4 className="mt-3 mb-1 text-[11px] font-semibold text-muted uppercase">
            Reported by the server
          </h4>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {detail.map(([key, value]) => (
              <Pair key={key} label={key} value={value === null ? 'NULL' : String(value)} />
            ))}
          </dl>
        </>
      )}
    </aside>
  );
}

/** Detail keys already shown as figures. */
const IN_FIGURES = new Set([
  'Shared Hit Blocks',
  'Shared Read Blocks',
  'Shared Dirtied Blocks',
  'Shared Written Blocks',
  'Local Hit Blocks',
  'Local Read Blocks',
  'Temp Read Blocks',
  'Temp Written Blocks',
]);

function Pair(props: { readonly label: string; readonly value: string }) {
  return (
    <>
      <dt className="text-muted">{props.label}</dt>
      <dd className="font-mono break-all whitespace-pre-wrap text-fg select-text">{props.value}</dd>
    </>
  );
}

import type {
  OperationKind,
  OperationStep,
  SyncObjectKind,
  SyncOperation,
  SyncWarning,
} from '../model';

/**
 * Coarse execution buckets (spec §13, step 6): drop foreign keys, drop dependents that block
 * changes, drop and alter tables, create tables, re-add foreign keys, then views, routines and
 * triggers. Reference edges between steps refine this order; the phase breaks ties.
 */
export const PHASE = {
  preTransaction: 0,
  createSchema: 5,
  createExtension: 7,
  alterExtension: 8,
  dropForeignKey: 20,
  dropTrigger: 30,
  dropView: 40,
  dropEvent: 45,
  dropTable: 50,
  renameTable: 60,
  dropConstraint: 70,
  dropColumn: 80,
  renameColumn: 85,
  renameConstraint: 87,
  createType: 90,
  recreateType: 92,
  createSequence: 95,
  alterColumn: 100,
  addColumn: 110,
  addConstraint: 120,
  alterTable: 130,
  createTable: 140,
  createPartition: 145,
  alterSequence: 150,
  dropSequence: 155,
  dropRoutine: 160,
  dropType: 165,
  addForeignKey: 170,
  createView: 180,
  createRoutine: 190,
  createTrigger: 200,
  createEvent: 210,
  dropExtension: 220,
  dropSchema: 230,
} as const;

export interface StepDraft {
  phase: number;
  statements: string[];
  preTransaction?: boolean;
  /** Object keys this step creates or reshapes; steps referencing them run after it. */
  provides: string[];
  /** Object keys this step drops; it runs after steps that stop referencing them. */
  removes: string[];
  /** Object keys the step's statements reference (source side). */
  refs: string[];
  /** Object keys the target object referenced before this step changed or dropped it. */
  targetRefs: string[];
}

export interface OpDraft {
  id: string;
  kind: OperationKind;
  objectKind: SyncObjectKind;
  name: string;
  qualifiedName: string;
  parent?: string;
  schema?: string;
  steps: StepDraft[];
  sourceDdl?: string;
  targetDdl?: string;
  destructive: boolean;
  warnings: SyncWarning[];
  changes: string[];
  reason?: string;
  requires: Set<string>;
  /** Unsupported changes hold no statements and start unselected. */
  unsupported?: boolean;
}

export function step(
  phase: number,
  statements: string[],
  partial: Partial<StepDraft> = {},
): StepDraft {
  return {
    phase,
    statements,
    provides: partial.provides ?? [],
    removes: partial.removes ?? [],
    refs: partial.refs ?? [],
    targetRefs: partial.targetRefs ?? [],
    ...(partial.preTransaction ? { preTransaction: true } : {}),
  };
}

type StepRef = readonly [number, number];

export class OperationBuilder {
  readonly ops: OpDraft[] = [];
  private readonly byId = new Map<string, OpDraft>();
  /** Explicit "b runs after a" edges between steps, by op id and step index. */
  private readonly edges: { before: [string, number]; after: [string, number] }[] = [];

  add(
    op: Omit<OpDraft, 'requires' | 'warnings' | 'changes' | 'destructive'> & Partial<OpDraft>,
  ): OpDraft {
    let id = op.id;
    for (let n = 2; this.byId.has(id); n++) id = `${op.id}#${n}`;
    const draft: OpDraft = {
      ...op,
      id,
      requires: op.requires ?? new Set(),
      warnings: op.warnings ?? [],
      changes: op.changes ?? [],
      destructive: op.destructive ?? false,
    };
    this.ops.push(draft);
    this.byId.set(id, draft);
    return draft;
  }

  get(id: string): OpDraft | undefined {
    return this.byId.get(id);
  }

  /** Requires `after`'s step to run after `before`'s step. */
  order(before: OpDraft, beforeStep: number, after: OpDraft, afterStep: number): void {
    this.edges.push({ before: [before.id, beforeStep], after: [after.id, afterStep] });
  }

  /**
   * Final operations in execution order, with selection dependencies and default selection
   * applied, plus the step order.
   */
  finish(): { operations: SyncOperation[]; order: StepRef[] } {
    this.deriveRequirements();
    const order = this.orderSteps();
    const firstPosition = new Map<number, number>();
    order.forEach(([op], position) => {
      if (!firstPosition.has(op)) firstPosition.set(op, position);
    });
    const opOrder = [...this.ops.keys()].sort(
      (a, b) => (firstPosition.get(a) ?? Infinity) - (firstPosition.get(b) ?? Infinity) || a - b,
    );
    const remap = new Map<number, number>(opOrder.map((old, index) => [old, index]));
    const operations = opOrder.map((index) => this.toOperation(this.ops[index]!));
    const unsupported = new Set(this.ops.filter((op) => op.unsupported).map((op) => op.id));
    const selected = applySelection(operations, (op) => !op.destructive && !unsupported.has(op.id));
    return {
      operations: selected,
      order: order.map(([op, s]) => [remap.get(op)!, s] as const),
    };
  }

  private toOperation(op: OpDraft): SyncOperation {
    const steps: OperationStep[] = op.steps.map((s) => ({
      phase: s.phase,
      statements: [...s.statements],
      ...(s.preTransaction ? { preTransaction: true } : {}),
    }));
    return {
      id: op.id,
      kind: op.kind,
      objectKind: op.objectKind,
      name: op.name,
      qualifiedName: op.qualifiedName,
      ...(op.parent !== undefined ? { parent: op.parent } : {}),
      ...(op.schema !== undefined ? { schema: op.schema } : {}),
      statements: op.steps.flatMap((s) => s.statements),
      ...(op.sourceDdl !== undefined ? { sourceDdl: op.sourceDdl } : {}),
      ...(op.targetDdl !== undefined ? { targetDdl: op.targetDdl } : {}),
      destructive: op.destructive,
      selected: true,
      dependsOn: [...op.requires].filter((id) => id !== op.id && this.byId.has(id)).sort(),
      warnings: op.warnings,
      changes: op.changes,
      ...(op.reason !== undefined ? { reason: op.reason } : {}),
      steps,
    };
  }

  /** An operation needs every operation that creates an object it references. */
  private deriveRequirements(): void {
    const creators = new Map<string, Set<string>>();
    for (const op of this.ops) {
      if (op.kind !== 'create' && op.kind !== 'rename') continue;
      for (const s of op.steps) {
        for (const key of s.provides) {
          let set = creators.get(key);
          if (!set) creators.set(key, (set = new Set()));
          set.add(op.id);
        }
      }
    }
    for (const op of this.ops) {
      for (const s of op.steps) {
        for (const ref of s.refs) {
          for (const creator of creators.get(ref) ?? []) {
            if (creator !== op.id) op.requires.add(creator);
          }
        }
      }
    }
  }

  private orderSteps(): StepRef[] {
    const steps: { op: number; step: number; draft: StepDraft; seq: number }[] = [];
    this.ops.forEach((op, o) =>
      op.steps.forEach((draft, s) => steps.push({ op: o, step: s, draft, seq: steps.length })),
    );
    const index = new Map<string, number>();
    steps.forEach((s, i) => index.set(`${this.ops[s.op]!.id}#${s.step}`, i));
    const successors: Set<number>[] = steps.map(() => new Set());
    const addEdge = (from: number, to: number): void => {
      if (from !== to && steps[from]!.op !== steps[to]!.op) successors[from]!.add(to);
    };

    const providers = new Map<string, number[]>();
    const removers = new Map<string, number[]>();
    const targetRefs = new Map<string, number[]>();
    const push = (map: Map<string, number[]>, key: string, i: number): void => {
      let list = map.get(key);
      if (!list) map.set(key, (list = []));
      list.push(i);
    };
    steps.forEach((s, i) => {
      for (const key of s.draft.provides) push(providers, key, i);
      for (const key of s.draft.removes) push(removers, key, i);
      for (const key of s.draft.targetRefs) push(targetRefs, key, i);
    });
    steps.forEach((s, i) => {
      // References run after whatever creates or reshapes them.
      for (const ref of s.draft.refs) for (const p of providers.get(ref) ?? []) addEdge(p, i);
      // A drop runs after every step that stops referencing the dropped object.
      for (const key of s.draft.removes) for (const r of targetRefs.get(key) ?? []) addEdge(r, i);
      // Re-creating a name runs after dropping it.
      for (const key of s.draft.provides) for (const r of removers.get(key) ?? []) addEdge(r, i);
    });
    for (const edge of this.edges) {
      const from = index.get(`${edge.before[0]}#${edge.before[1]}`);
      const to = index.get(`${edge.after[0]}#${edge.after[1]}`);
      if (from !== undefined && to !== undefined) addEdge(from, to);
    }
    // Steps of one operation keep their order.
    steps.forEach((s, i) => {
      const next = steps[i + 1];
      if (next !== undefined && next.op === s.op) successors[i]!.add(i + 1);
    });

    const indegree = steps.map(() => 0);
    successors.forEach((set) => set.forEach((to) => indegree[to]!++));
    const done = steps.map(() => false);
    const result: StepRef[] = [];
    const before = (a: number, b: number): boolean => {
      const pa = steps[a]!.draft.phase;
      const pb = steps[b]!.draft.phase;
      return pa < pb || (pa === pb && steps[a]!.seq < steps[b]!.seq);
    };
    const ready = new MinHeap(before);
    steps.forEach((_s, i) => {
      if (indegree[i] === 0) ready.push(i);
    });
    while (result.length < steps.length) {
      let pick = ready.pop();
      if (pick === undefined) {
        // A reference cycle: fall back to the phase order for the earliest remaining step.
        for (let i = 0; i < steps.length; i++) {
          if (!done[i] && (pick === undefined || before(i, pick))) pick = i;
        }
      }
      if (pick === undefined || done[pick]) continue;
      done[pick] = true;
      result.push([steps[pick]!.op, steps[pick]!.step]);
      for (const to of successors[pick]!) {
        indegree[to]!--;
        if (indegree[to] === 0 && !done[to]) ready.push(to);
      }
    }
    return result;
  }
}

/**
 * Applies a selection rule and then closes it over dependencies: an operation whose dependency
 * is unselected is unselected too.
 */
export function applySelection(
  operations: readonly SyncOperation[],
  initial: (op: SyncOperation) => boolean,
): SyncOperation[] {
  const selected = new Map(operations.map((op) => [op.id, initial(op)]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const op of operations) {
      if (!selected.get(op.id)) continue;
      if (op.dependsOn.some((dep) => selected.get(dep) === false)) {
        selected.set(op.id, false);
        changed = true;
      }
    }
  }
  return operations.map((op) => ({ ...op, selected: selected.get(op.id) ?? false }));
}

/** A binary heap of step indexes ordered by a "runs before" predicate. */
class MinHeap {
  private readonly items: number[] = [];

  constructor(private readonly before: (a: number, b: number) => boolean) {}

  push(item: number): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(items[i]!, items[parent]!)) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }

  pop(): number | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && this.before(items[left]!, items[smallest]!)) smallest = left;
        if (right < items.length && this.before(items[right]!, items[smallest]!)) smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest]!, items[i]!];
        i = smallest;
      }
    }
    return top;
  }
}

import { QuerybaraError, newId } from '@querybara/core';
import {
  AGGREGATION_STAGES,
  formatShell,
  isBsonDocument,
  locationAt,
  parseShell,
  parseShellDocument,
  parseShellPipeline,
  stageInfo,
  stageOperator,
  toEjson,
  type BsonDocument,
  type BsonValue,
} from '@querybara/mongo-tools';

import { issueOf, type TextIssue } from './query-bar';

/**
 * The aggregation editor's stage list (spec §9, "one card per stage"): each stage is an
 * operator picked from mongo-tools' stage list and its body typed in mongosh syntax, checked as
 * the user types, and switched on or off. The list edits as cards (add, remove, reorder,
 * toggle) or as one pipeline text, kept in step both ways: disabled stages appear in the text as
 * `//` comments, and a commented-out stage in the text comes back as a disabled card.
 */

export interface PipelineStage {
  readonly id: string;
  /** The stage operator, e.g. "$match". */
  readonly operator: string;
  /** The operator's value in mongosh syntax, e.g. "{ status: 'open' }" or "10". */
  readonly body: string;
  readonly enabled: boolean;
}

/** A stage checked: its parsed value, a syntax problem, or a placement warning. */
export interface StageCheck {
  readonly issue: TextIssue | undefined;
  readonly warning: string | undefined;
}

const OPERATOR = /^\$[A-Za-z][A-Za-z0-9]*$/;

/** A new stage with the operator's skeleton as its body (or the body given). */
export function newStage(operator: string, body?: string): PipelineStage {
  return {
    id: newId(),
    operator,
    body: body ?? stageInfo(operator)?.template ?? '{}',
    enabled: true,
  };
}

/** Parses a stage body; throws a located error. */
export function parseStageBody(stage: Pick<PipelineStage, 'operator' | 'body'>): BsonValue {
  if (!OPERATOR.test(stage.operator)) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `"${stage.operator}" is not a stage operator`,
    });
  }
  if (stage.body.trim() === '') {
    throw new QuerybaraError({ code: 'VALIDATION_FAILED', message: 'The stage is empty' });
  }
  return parseShell(stage.body);
}

/** The stage as a pipeline document. */
export function stageDocument(stage: Pick<PipelineStage, 'operator' | 'body'>): BsonDocument {
  const value = parseStageBody(stage);
  const doc: BsonDocument = {};
  Object.defineProperty(doc, stage.operator, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return doc;
}

/** Where a stage has to be: first or last (among the enabled ones), per mongo-tools. */
function placementWarning(
  stage: PipelineStage,
  value: BsonValue,
  position: number,
  enabled: number,
): string | undefined {
  const info = stageInfo(stage.operator);
  if (info?.position === 'first' && position !== 0) {
    return `${stage.operator} must be the first stage`;
  }
  if (info?.position === 'last' && position !== enabled - 1) {
    return `${stage.operator} must be the last stage`;
  }
  if (stage.operator === '$match' && isBsonDocument(value) && '$text' in value && position !== 0) {
    return 'A $match with $text must be the first stage';
  }
  if (!info) return `${stage.operator} is not in Querybara's stage list; the server checks it`;
  return undefined;
}

/** Every stage's check, by stage id. */
export function checkStages(stages: readonly PipelineStage[]): Record<string, StageCheck> {
  const checks: Record<string, StageCheck> = {};
  const enabled = stages.filter((stage) => stage.enabled).length;
  let position = 0;
  for (const stage of stages) {
    let value: BsonValue | undefined;
    let issue: TextIssue | undefined;
    try {
      value = parseStageBody(stage);
    } catch (error) {
      issue = issueOf(stage.body, error);
    }
    const warning =
      stage.enabled && value !== undefined
        ? placementWarning(stage, value, position, enabled)
        : undefined;
    if (stage.enabled) position += 1;
    checks[stage.id] = { issue, warning };
  }
  return checks;
}

// ---------------------------------------------------------------------------------------------
// List operations (each returns a new list)

/** Inserts a stage after `index` (-1: at the start; past the end: at the end). */
export function insertStage(
  stages: readonly PipelineStage[],
  index: number,
  stage: PipelineStage,
): PipelineStage[] {
  const at = Math.max(0, Math.min(stages.length, index + 1));
  return [...stages.slice(0, at), stage, ...stages.slice(at)];
}

export function removeStage(stages: readonly PipelineStage[], id: string): PipelineStage[] {
  return stages.filter((stage) => stage.id !== id);
}

/** Moves the stage at `from` to `to` (both clamped); the drag and keyboard reorder. */
export function moveStage(
  stages: readonly PipelineStage[],
  from: number,
  to: number,
): PipelineStage[] {
  if (from < 0 || from >= stages.length) return [...stages];
  const target = Math.max(0, Math.min(stages.length - 1, to));
  if (target === from) return [...stages];
  const next = [...stages];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved!);
  return next;
}

function patchStage(
  stages: readonly PipelineStage[],
  id: string,
  patch: (stage: PipelineStage) => Partial<PipelineStage>,
): PipelineStage[] {
  return stages.map((stage) => (stage.id === id ? { ...stage, ...patch(stage) } : stage));
}

export function toggleStage(stages: readonly PipelineStage[], id: string): PipelineStage[] {
  return patchStage(stages, id, (stage) => ({ enabled: !stage.enabled }));
}

export function setStageBody(
  stages: readonly PipelineStage[],
  id: string,
  body: string,
): PipelineStage[] {
  return patchStage(stages, id, () => ({ body }));
}

/**
 * Changes a stage's operator. A body still equal to the old operator's skeleton (or empty) is
 * replaced by the new one's; anything the user typed is kept.
 */
export function setStageOperator(
  stages: readonly PipelineStage[],
  id: string,
  operator: string,
): PipelineStage[] {
  return patchStage(stages, id, (stage) => {
    const untouched =
      stage.body.trim() === '' || stage.body === stageInfo(stage.operator)?.template;
    return {
      operator,
      ...(untouched ? { body: stageInfo(operator)?.template ?? stage.body } : {}),
    };
  });
}

/** Operators offered by the picker, with the stage's own when it is not in the list. */
export function operatorChoices(current?: string): string[] {
  const names = AGGREGATION_STAGES.map((stage) => stage.name);
  return current !== undefined && !names.includes(current) ? [current, ...names] : names;
}

/** Indexes of the stages switched off. */
export function disabledIndexes(stages: readonly PipelineStage[]): number[] {
  return stages.flatMap((stage, i) => (stage.enabled ? [] : [i]));
}

/**
 * The pipeline as documents: the enabled stages (or all of them); throws, naming the stage,
 * when one does not parse.
 */
export function pipelineDocuments(
  stages: readonly PipelineStage[],
  options: { readonly includeDisabled?: boolean } = {},
): BsonDocument[] {
  const out: BsonDocument[] = [];
  stages.forEach((stage, i) => {
    if (!stage.enabled && options.includeDisabled !== true) return;
    try {
      out.push(stageDocument(stage));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: `Stage ${i + 1} (${stage.operator}): ${message}`,
      });
    }
  });
  return out;
}

/** The pipeline as canonical Extended JSON, for the connection host. */
export function pipelineEjson(
  stages: readonly PipelineStage[],
  options: { readonly includeDisabled?: boolean } = {},
): string {
  return toEjson(pipelineDocuments(stages, options));
}

/** True when the last enabled stage writes ($out, $merge). */
export function pipelineWritesOutput(stages: readonly PipelineStage[]): boolean {
  const last = [...stages].reverse().find((stage) => stage.enabled);
  return last !== undefined && stageInfo(last.operator)?.writes === true;
}

// ---------------------------------------------------------------------------------------------
// The pipeline as one text

function indentRest(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 || line === '' ? line : `${indent}${line}`))
    .join('\n');
}

/** One stage as the text shows it: `{ $match: <body> }`, commented out when disabled. */
function stageText(stage: PipelineStage, last: boolean): string {
  const text = `{ ${stage.operator}: ${indentRest(stage.body.trim(), '  ')} }${last ? '' : ','}`;
  const lines = text.split('\n');
  return lines.map((line) => `  ${stage.enabled ? '' : '// '}${line}`).join('\n');
}

/**
 * The whole pipeline as mongosh text: one stage per entry, bodies as typed, disabled stages as
 * `//` comments (so the text still runs as it is in mongosh, without them).
 */
export function pipelineText(stages: readonly PipelineStage[]): string {
  if (stages.length === 0) return '[]';
  return `[\n${stages.map((stage, i) => stageText(stage, i === stages.length - 1)).join('\n')}\n]`;
}

/** The body text of a parsed stage value. */
export function bodyText(value: BsonValue): string {
  return formatShell(value);
}

interface CommentBlock {
  /** Offset of the first `//`. */
  readonly start: number;
  /** Offset just past the last comment line (before its newline). */
  readonly end: number;
  readonly content: string;
  /** The code character before the block and after it ('' at either end of the text). */
  readonly before: string;
  readonly after: string;
}

/**
 * Runs of whole-line `//` comments directly inside the top-level array: the candidates for
 * disabled stages. Strings, block comments and regular expressions in simple cases are skipped.
 */
function commentBlocks(text: string): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  let depth = 0;
  let current: { start: number; end: number; lines: string[]; before: string } | undefined;
  let lineHasCode = false;
  let lastSignificant = '';
  const close = (after: string): void => {
    if (current) {
      const { start, end, lines, before } = current;
      blocks.push({ start, end, content: lines.join('\n'), before, after });
    }
    current = undefined;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\n') {
      lineHasCode = false;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') continue;
    if (c === '/' && text[i + 1] === '/') {
      const lineEnd = text.indexOf('\n', i);
      const end = lineEnd === -1 ? text.length : lineEnd;
      if (!lineHasCode && depth === 1) {
        const line = text.slice(i + 2, end).replace(/^ /, '');
        if (current) {
          current.lines.push(line);
          current.end = end;
        } else {
          current = { start: i, end, lines: [line], before: lastSignificant };
        }
      }
      i = end - 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const closeAt = text.indexOf('*/', i + 2);
      i = closeAt === -1 ? text.length : closeAt + 1;
      continue;
    }
    close(c);
    lineHasCode = true;
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      i = j;
      lastSignificant = c;
      continue;
    }
    if (c === '/' && !/[\w$)\]}]/.test(lastSignificant)) {
      // A regular expression literal.
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        const d = text[j]!;
        if (d === '\\') j += 1;
        else if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j += 1;
      }
      i = j;
      lastSignificant = '/';
      continue;
    }
    if (c === '[' || c === '{' || c === '(') depth += 1;
    else if (c === ']' || c === '}' || c === ')') depth -= 1;
    lastSignificant = c;
  }
  close('');
  return blocks;
}

const DISABLED_KEY = '$__querybaraDisabledStage';

export type ParsedPipelineText =
  | { readonly ok: true; readonly stages: PipelineStage[] }
  | { readonly ok: false; readonly issue: TextIssue };

/**
 * Parses pipeline text back into stages. Whole-line `//` comments inside the array that hold a
 * stage document become disabled stages at their place; other comments are ignored. Stage ids
 * are kept from `previous` where the operator and position match, so cards keep their previews.
 */
export function parsePipelineText(
  text: string,
  previous: readonly PipelineStage[] = [],
): ParsedPipelineText {
  const disabled: BsonDocument[] = [];
  const replacements: { start: number; end: number; text: string }[] = [];
  for (const block of commentBlocks(text)) {
    const content = block.content.trim().replace(/,\s*$/, '');
    let doc: BsonDocument;
    try {
      doc = parseShellDocument(content);
      stageOperator(doc);
    } catch {
      continue;
    }
    const { before, after } = block;
    const placeholder = `${before === '[' || before === ',' ? '' : ','}{ ${DISABLED_KEY}: ${disabled.length} }${after === ']' || after === ',' ? '' : ','}`;
    disabled.push(doc);
    replacements.push({ start: block.start, end: block.end, text: placeholder });
  }
  let transformed = '';
  let at = 0;
  for (const r of replacements) {
    transformed += text.slice(at, r.start) + r.text;
    at = r.end;
  }
  transformed += text.slice(at);
  /** An offset in the transformed text back to the user's text. */
  const original = (offset: number): number => {
    let delta = 0;
    for (const r of replacements) {
      const start = r.start + delta;
      if (offset < start) break;
      if (offset < start + r.text.length) return r.start;
      delta += r.text.length - (r.end - r.start);
    }
    return Math.max(0, Math.min(text.length, offset - delta));
  };
  try {
    const documents = parseShellPipeline(transformed);
    const stages = documents.map((doc, i): PipelineStage => {
      const marker = doc[DISABLED_KEY];
      const enabled = marker === undefined;
      const stageDoc = enabled ? doc : disabled[Number(marker)]!;
      let operator: string;
      try {
        operator = stageOperator(stageDoc);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: `Stage ${i + 1}: ${message}`,
        });
      }
      const kept = previous[i];
      return {
        id: kept && kept.operator === operator ? kept.id : newId(),
        operator,
        body: bodyText(stageDoc[operator]!),
        enabled,
      };
    });
    return { ok: true, stages };
  } catch (error) {
    const issue = issueOf(transformed, error);
    const offset = original(issue.offset);
    const { line, column } = locationAt(text, offset);
    return { ok: false, issue: { message: issue.message, offset, line, column } };
  }
}

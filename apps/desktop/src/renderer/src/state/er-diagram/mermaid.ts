import { keyLetters, tableLabel, type ErDiagram, type ErEnd } from './model';

/**
 * The ER diagram as Mermaid `erDiagram` text, for Markdown that renders it (GitHub, GitLab,
 * Notion, most wikis): an entity per table with its columns, types and keys, and a line per
 * foreign key with the same crow's-foot ends as the canvas. Mermaid names allow letters,
 * digits, `_` and `-` only, so other characters become `_` and the real name shows as the
 * entity's alias. Pure.
 */

export interface MermaidOptions {
  /** Tables to leave out (hidden on the canvas). */
  readonly hidden?: ReadonlySet<string>;
  /** Column types, as on the canvas. */
  readonly types?: boolean;
}

/** Left-hand ends (the referenced table is written first). */
const LEFT: Readonly<Record<ErEnd, string>> = {
  one: '||',
  'zero-or-one': '|o',
  'zero-or-many': '}o',
};

/** Right-hand ends (the referencing table). */
const RIGHT: Readonly<Record<ErEnd, string>> = {
  one: '||',
  'zero-or-one': 'o|',
  'zero-or-many': 'o{',
};

function word(text: string, fallback: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9_-]/g, '_');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `${fallback}${cleaned}`;
}

function typeWord(type: string): string {
  const cleaned = type.trim().replace(/[^A-Za-z0-9_()[\]-]/g, '_');
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `t_${cleaned}`;
}

function quoted(text: string): string {
  return `"${text.replace(/"/g, "'")}"`;
}

export function diagramMermaid(diagram: ErDiagram, options: MermaidOptions = {}): string {
  const tables = diagram.tables.filter((table) => !options.hidden?.has(table.id));
  const shown = new Set(tables.map((table) => table.id));
  // Unique entity names, stable across runs: the first table keeps the plain name.
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const table of tables) {
    const base = word(tableLabel(diagram, table).replace('.', '__'), 'T_');
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}_${n}`;
    taken.add(name.toLowerCase());
    names.set(table.id, name);
  }

  const lines = ['erDiagram'];
  for (const relation of diagram.relations) {
    const parent = names.get(relation.parent);
    const child = names.get(relation.child);
    if (!parent || !child || !shown.has(relation.parent) || !shown.has(relation.child)) continue;
    lines.push(
      `    ${parent} ${LEFT[relation.parentEnd]}--${RIGHT[relation.childEnd]} ${child} : ${quoted(relation.name || relation.childColumns.join(', '))}`,
    );
  }
  for (const table of tables) {
    const name = names.get(table.id)!;
    const label = tableLabel(diagram, table);
    const head = label === name ? name : `${name}[${quoted(label)}]`;
    if (table.columns.length === 0) {
      lines.push(`    ${head} {`, '    }');
      continue;
    }
    lines.push(`    ${head} {`);
    for (const column of table.columns) {
      const keys = keyLetters(column).map((letter) => ({ P: 'PK', F: 'FK', U: 'UK' })[letter]);
      const type = options.types === false || !column.type ? 'column' : typeWord(column.type);
      const columnName = word(column.name, 'c_');
      const comment = columnName === column.name ? '' : ` ${quoted(column.name)}`;
      lines.push(
        `        ${type} ${columnName}${keys.length > 0 ? ` ${keys.join(', ')}` : ''}${comment}`,
      );
    }
    lines.push('    }');
  }
  return `${lines.join('\n')}\n`;
}

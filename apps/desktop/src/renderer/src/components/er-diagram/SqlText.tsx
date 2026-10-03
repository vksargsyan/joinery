import type { SqlDialect } from '@querybara/core';
import { tokenize } from '@querybara/sql-tools';
import { useMemo } from 'react';

import { cx } from '../ui';

/**
 * A read-only SQL script, highlighted with Querybara's lexer (the editor's own tokens, no editor):
 * keywords, names, strings, numbers and comments. Selectable, for copying a part of it.
 */
export function SqlText(props: {
  readonly sql: string;
  readonly dialect: SqlDialect;
  readonly className?: string;
  readonly testId?: string;
}) {
  const tokens = useMemo(() => tokenize(props.sql, props.dialect), [props.sql, props.dialect]);
  return (
    <pre
      data-testid={props.testId}
      className={cx(
        'overflow-auto font-mono text-[12px] leading-[1.55] whitespace-pre text-fg select-text',
        props.className,
      )}
    >
      {tokens.map((token, i) => {
        const { text } = token;
        const className =
          token.kind === 'line-comment' || token.kind === 'block-comment'
            ? 'text-muted italic'
            : token.kind === 'string' || token.kind === 'dollar-string'
              ? 'text-success'
              : token.kind === 'number'
                ? 'text-warning'
                : token.kind === 'quoted-identifier'
                  ? 'text-fg'
                  : token.kind === 'word' && /^[A-Z][A-Z_]*$/.test(text)
                    ? 'font-semibold text-accent'
                    : undefined;
        return className ? (
          <span key={i} className={className}>
            {text}
          </span>
        ) : (
          text
        );
      })}
    </pre>
  );
}

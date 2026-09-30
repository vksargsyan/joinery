import { ENGINES, type EngineId } from '@joinery/core';
import type { ReactNode } from 'react';

import { cx } from './ui';

/**
 * Which database a connection is, at a glance: a pictogram per engine in the Kiln Glyphs manner
 * (a 16px grid, 1.3 strokes with round caps, a 16% wash in the glyph's colour). These are
 * simplified outlines, not the projects' logos (Kiln redraws no brand marks), each in one glaze:
 * the PostgreSQL elephant cobalt, the MySQL dolphin ochre, the MariaDB seal peach, the MongoDB
 * leaf celadon, the Redis stack red, the Elasticsearch "e" teal. The engine's name is the
 * tooltip; the icon itself is hidden from assistive technology, next to the connection's name.
 */

const wash = { fill: 'currentColor', fillOpacity: 0.16 } as const;
const dot = { fill: 'currentColor', stroke: 'none' } as const;

const GLYPHS: Readonly<Record<EngineId, ReactNode>> = {
  postgres: (
    <>
      <path d="M5.3 3.7C3.2 3 1.7 4.2 1.7 6.3c0 2 1.4 3.3 3.3 3.4" />
      <path d="M10.7 3.7c2.1-.7 3.6.5 3.6 2.6 0 2-1.4 3.3-3.3 3.4" />
      <path
        d="M5 10.3c-.6-.8-.8-1.8-.8-3C4.2 4.9 5.9 3 8 3s3.8 1.9 3.8 4.3c0 1.2-.2 2.2-.8 3"
        {...wash}
      />
      <path d="M6.9 9.7v2.5c0 1.2.7 2.05 1.6 2.05.7 0 1.2-.5 1.2-1.1M9.1 9.7v2.3" />
      <circle cx="6.3" cy="7" r=".55" {...dot} />
      <circle cx="9.7" cy="7" r=".55" {...dot} />
    </>
  ),
  mysql: (
    <>
      <path
        d="M3.3 12.2C4.4 7.9 7.7 4.6 11.7 4.4c1-.05 1.95.35 2.7 1.1l-1.5.7c-.25 1-1 1.7-2 1.9C7.8 8.7 5.4 10.1 3.3 12.2z"
        {...wash}
      />
      <path d="M6.3 7.5 5.6 4.6l2.9 1.6M3.3 12.2 1.5 11.3M3.3 12.2l.2 2M8.7 8.5l.5 1.8" />
      <circle cx="12.1" cy="5.6" r=".5" {...dot} />
    </>
  ),
  mariadb: (
    <>
      <path
        d="M1.9 12.6c2.9.2 5.3-.5 7.1-2.3 1.2-1.2 1.8-2.8 2-4.3.1-1 .9-1.75 1.9-1.75s1.75.8 1.75 1.8c0 .8-.45 1.5-1.15 1.8l.2 1.5c.2 1.6-.6 3-2 3.7-1.1.55-2.3.8-3.6.8H1.9z"
        {...wash}
      />
      <path d="M1.9 12.6 1 11.3M1.9 12.6 1 13.9M9.3 13.1l1.1 1.3" />
      <circle cx="13" cy="5.6" r=".5" {...dot} />
    </>
  ),
  mongodb: (
    <>
      <path
        d="M8 1.6c2.8 2.3 4 5 3.6 8-.3 2.1-1.7 3.5-3.6 4.4-1.9-.9-3.3-2.3-3.6-4.4C4 6.6 5.2 3.9 8 1.6z"
        {...wash}
      />
      <path d="M8 4.6v10" />
    </>
  ),
  redis: (
    <>
      <path d="M8 2.4 13.6 5 8 7.6 2.4 5z" {...wash} />
      <path d="M2.4 8.2 8 10.8l5.6-2.6M2.4 11.2 8 13.8l5.6-2.6" />
    </>
  ),
  elasticsearch: <path d="M12.9 5.3A5.6 5.6 0 1 0 12.9 10.7M4.8 8h8.6" />,
};

/** Each engine's glaze, as a text colour class. */
export const ENGINE_TONES: Readonly<Record<EngineId, string>> = {
  postgres: 'text-cobalt',
  mysql: 'text-ochre',
  mariadb: 'text-peach',
  mongodb: 'text-celadon',
  redis: 'text-danger',
  elasticsearch: 'text-teal',
};

export function EngineIcon(props: { readonly engine: EngineId; readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-engine={props.engine}
      className={cx('h-4 w-4 shrink-0', ENGINE_TONES[props.engine], props.className)}
    >
      <title>{ENGINES[props.engine].displayName}</title>
      {GLYPHS[props.engine]}
    </svg>
  );
}

import {
  createContext,
  forwardRef,
  useContext,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

import type { QueryBuilder, QueryBuilderState } from '../../state/query-builder/builder';
import { useBuilderState } from '../../state/query-builder/builder';
import { cx } from '../ui';

/** Small controls and the builder context shared by the query builder's parts. */

const BuilderContext = createContext<QueryBuilder | undefined>(undefined);

export const BuilderProvider = BuilderContext.Provider;

/** The builder of the panel around the component. */
export function useBuilder(): QueryBuilder {
  const builder = useContext(BuilderContext);
  if (!builder) throw new Error('useBuilder outside a query builder panel');
  return builder;
}

/** Part of the builder's state, re-rendering when it changes. */
export function useBuilderSelector<T>(selector: (state: QueryBuilderState) => T): T {
  return useBuilderState(useBuilder(), selector);
}

/** True while the SQL holds something the builder cannot show (edits are refused). */
export function useReadOnly(): boolean {
  return useBuilderSelector((state) => state.sync.status !== 'synced');
}

const CONTROL =
  'h-7 min-w-0 rounded border border-border bg-panel-2 px-1.5 text-xs text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none aria-[invalid=true]:border-danger disabled:opacity-50';

export const SmallSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function SmallSelect({ className, ...props }, ref) {
    return <select ref={ref} className={cx(CONTROL, className)} {...props} />;
  },
);

export const SmallInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function SmallInput({ className, ...props }, ref) {
    return <input ref={ref} className={cx(CONTROL, className)} {...props} />;
  },
);

/** A square icon button with a required accessible name. */
export function IconButton(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly label: string;
    readonly children: ReactNode;
  },
) {
  const { label, className, children, ...rest } = props;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Move up, move down and remove buttons of a list row. */
export function RowActions(props: {
  readonly name: string;
  readonly first: boolean;
  readonly last: boolean;
  readonly disabled: boolean;
  readonly onMove?: (delta: number) => void;
  readonly onRemove: () => void;
}) {
  return (
    <span className="flex shrink-0 items-center">
      {props.onMove && (
        <>
          <IconButton
            label={`Move ${props.name} up`}
            disabled={props.disabled || props.first}
            onClick={() => props.onMove?.(-1)}
          >
            ↑
          </IconButton>
          <IconButton
            label={`Move ${props.name} down`}
            disabled={props.disabled || props.last}
            onClick={() => props.onMove?.(1)}
          >
            ↓
          </IconButton>
        </>
      )}
      <IconButton label={`Remove ${props.name}`} disabled={props.disabled} onClick={props.onRemove}>
        ×
      </IconButton>
    </span>
  );
}

export function EmptyHint({ children }: { readonly children: ReactNode }) {
  return <p className="px-1 py-1 text-xs text-muted">{children}</p>;
}

export function SectionTitle({ children }: { readonly children: ReactNode }) {
  return (
    <h3 className="mt-2 mb-1 text-[11px] font-semibold tracking-wide text-muted uppercase first:mt-0">
      {children}
    </h3>
  );
}

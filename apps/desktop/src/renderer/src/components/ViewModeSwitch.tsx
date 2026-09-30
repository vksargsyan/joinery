import { Icon, cx, type IconName } from './ui';

/**
 * How a result is shown (grid, form, JSON, tree...), as Navicat's icon toggles in the bottom
 * right corner of a data view. Each is a radio named for screen readers and tests ("Grid",
 * "Form", "JSON"), with its name as the tooltip; the chosen one is rust on the badge ground.
 */

export interface ViewModeOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon: IconName;
}

export function ViewModeSwitch<T extends string>(props: {
  readonly options: readonly ViewModeOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly label?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={props.label ?? 'View'}
      className="flex items-center gap-0.5 border-l border-border pl-2"
    >
      {props.options.map((option) => {
        const checked = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.label}
            title={option.label}
            onClick={() => props.onChange(option.value)}
            className={cx(
              'flex h-[20px] w-[24px] items-center justify-center rounded-sm',
              checked ? 'bg-badge text-rust' : 'text-muted hover:bg-hover hover:text-fg',
            )}
          >
            <Icon name={option.icon} className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}

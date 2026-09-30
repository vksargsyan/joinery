import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';

import { Icon, cx, type IconName } from './ui';

/** A menu item, with its glyph when it has one (every tree menu's items do). */
export function MenuItem(props: {
  readonly children: ReactNode;
  readonly onSelect: () => void;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly icon?: IconName;
}) {
  return (
    <DropdownMenu.Item
      onSelect={props.onSelect}
      disabled={props.disabled}
      className={cx(
        'flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-list-active',
        props.danger && 'text-danger',
      )}
    >
      {props.icon !== undefined && (
        <Icon name={props.icon} className={props.danger ? 'text-danger' : 'text-muted'} />
      )}
      {props.children}
    </DropdownMenu.Item>
  );
}

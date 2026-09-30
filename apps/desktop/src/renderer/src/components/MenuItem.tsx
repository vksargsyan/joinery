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

/** A menu item that opens a submenu to its side, with its glyph and a chevron. */
export function MenuSub(props: {
  readonly label: ReactNode;
  readonly icon?: IconName;
  readonly children: ReactNode;
  readonly disabled?: boolean;
}) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger
        disabled={props.disabled}
        className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-list-active data-[state=open]:bg-list-active"
      >
        {props.icon !== undefined && <Icon name={props.icon} className="text-muted" />}
        <span className="flex-1">{props.label}</span>
        <Icon name="chevron-right" className="h-3 w-3 text-muted" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          sideOffset={4}
          alignOffset={-5}
          className="z-50 max-h-80 min-w-48 overflow-auto rounded border border-border bg-raised p-1 text-[13px] shadow-widget"
        >
          {props.children}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

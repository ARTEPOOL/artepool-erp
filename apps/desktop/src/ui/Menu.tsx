import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  Menu as AriaMenu,
  MenuItem,
  MenuTrigger,
  Popover,
} from 'react-aria-components';
import styles from './Menu.module.css';

export interface MenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  onAction: () => void;
}

/** A button that opens a short list of actions (keyboard and screen reader ready). */
export function ActionMenu(props: { label: string; trigger: ReactNode; actions: MenuAction[] }) {
  return (
    <MenuTrigger>
      <AriaButton aria-label={props.label} className={styles.trigger}>
        {props.trigger}
      </AriaButton>
      <Popover placement="bottom end" className={styles.popover}>
        <AriaMenu
          className={styles.menu}
          onAction={(key) => props.actions.find((a) => a.id === key)?.onAction()}
        >
          {props.actions.map((action) => (
            <MenuItem
              key={action.id}
              id={action.id}
              className={styles.item}
              textValue={action.label}
            >
              {action.icon}
              {action.label}
            </MenuItem>
          ))}
        </AriaMenu>
      </Popover>
    </MenuTrigger>
  );
}

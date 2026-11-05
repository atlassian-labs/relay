import type { ListItem } from "../autocomplete";
import type { useApp } from "../state";

export type SelectionOverlayApp = ReturnType<typeof useApp>;

export interface SelectionOverlayBehavior {
  readonly closeOnSelect?: boolean;
  readonly onSelect: (item: ListItem<any>, app: SelectionOverlayApp) => void;
}

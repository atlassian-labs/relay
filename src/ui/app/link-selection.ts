import type { ListItem } from "../autocomplete";
import { truncateTextEnd } from "../util/format";
import type { MarkdownLink } from "../util/links";

export function linkSelectionItems(links: MarkdownLink[]): ListItem<string>[] {
  return links.map((link) => ({
    label: link.label === link.url ? truncateTextEnd(link.url, 70) : link.label,
    description: truncateTextEnd(link.url, 60),
    value: link.url,
  }));
}

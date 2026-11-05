import { useSharedTerminalDimensions } from "../context/terminal-dimensions";
import { useApp } from "../state";
import {
  clampDimension,
  UI_MODAL_HORIZONTAL_MARGIN,
  UI_MODAL_MAX_WIDTH,
  UI_MODAL_MIN_WIDTH,
  UI_MODAL_VERTICAL_MARGIN,
} from "../layout";
import { ModalFrame } from "./modal-frame";
import { ModalHeader, ModalKeyValue, ModalSectionHeading } from "./modal-layout";

function formatNumber(value: number | null): string {
  return value === null ? "—" : Math.round(value).toLocaleString("en-US");
}

function formatPercent(used: number | null, size: number | null): string {
  if (used === null || size === null || size <= 0) return "—";
  return `${((used / size) * 100).toFixed(1)}%`;
}

export function TokenUsageModal(props: { open: () => boolean; onClose: () => void }) {
  const app = useApp();
  const dims = useSharedTerminalDimensions();

  const modalWidth = () =>
    clampDimension(
      64,
      Math.min(UI_MODAL_MIN_WIDTH, Math.max(1, dims().width - 2)),
      Math.min(UI_MODAL_MAX_WIDTH, Math.max(1, dims().width - UI_MODAL_HORIZONTAL_MARGIN)),
    );
  const modalHeight = () => Math.min(15, Math.max(1, dims().height - UI_MODAL_VERTICAL_MARGIN));
  const modalTop = () => Math.max(0, Math.floor((dims().height - modalHeight()) / 2));
  const contentWidth = () => Math.max(0, modalWidth() - 4);
  const remaining = () => {
    const used = app.state.contextTokens;
    const size = app.state.contextWindow;
    return used === null || size === null ? null : Math.max(0, size - used);
  };

  return (
    <ModalFrame open={props.open} width={modalWidth} height={modalHeight} top={modalTop} onClose={props.onClose}>
      <ModalHeader title="Token usage" right="esc" width={contentWidth} />
      <box height={1} />
      <ModalSectionHeading>Context</ModalSectionHeading>
      <ModalKeyValue label="Used" value={() => formatNumber(app.state.contextTokens)} />
      <ModalKeyValue label="Window size" value={() => formatNumber(app.state.contextWindow)} />
      <ModalKeyValue label="Remaining" value={() => formatNumber(remaining())} />
      <ModalKeyValue label="Usage" value={() => formatPercent(app.state.contextTokens, app.state.contextWindow)} />
      <box height={1} />
      <ModalSectionHeading>Tokens</ModalSectionHeading>
      <ModalKeyValue label="Input" value={() => formatNumber(app.state.totalUsage.input_tokens)} />
      <ModalKeyValue label="Output" value={() => formatNumber(app.state.totalUsage.output_tokens)} />
      <ModalKeyValue label="Cache read" value={() => formatNumber(app.state.totalUsage.cache_read_tokens)} />
      <ModalKeyValue label="Cache write" value={() => formatNumber(app.state.totalUsage.cache_write_tokens)} />
    </ModalFrame>
  );
}

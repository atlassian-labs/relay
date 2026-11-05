import { Show, type JSX } from "solid-js";
import { useSharedTerminalDimensions } from "../context/terminal-dimensions";
import { getColors } from "../context/theme";
import { clampDimension, UI_MODAL_HORIZONTAL_MARGIN, UI_MODAL_MIN_WIDTH } from "../layout";
import { MODAL_BACKDROP_COLOR } from "./modal-backdrop";

interface ModalSurfaceProps {
  width: () => number;
  height: () => number;
  top?: () => number;
  zIndex?: number;
  onMouseDown?: (event: { stopPropagation?: () => void }) => void;
  children: JSX.Element;
}

export function ModalSurface(props: ModalSurfaceProps) {
  const dims = useSharedTerminalDimensions();
  const colors = getColors();
  const top = () => props.top?.() ?? Math.max(0, Math.floor((dims().height - props.height()) / 2));
  const left = () => Math.max(0, Math.floor((dims().width - props.width()) / 2));

  return (
    <box
      position="absolute"
      zIndex={props.zIndex ?? 3001}
      top={top()}
      left={left()}
      width={props.width()}
      height={props.height()}
      flexDirection="column"
      backgroundColor={colors.panel}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      onMouseDown={props.onMouseDown ?? ((event) => event.stopPropagation?.())}
    >
      {props.children}
    </box>
  );
}

export function ModalFrame(props: {
  open: () => boolean;
  width?: () => number;
  height?: () => number;
  maxWidth?: () => number;
  top?: () => number;
  zIndex?: number;
  dimBackground?: boolean;
  onClose?: () => void;
  children: JSX.Element;
}) {
  const dims = useSharedTerminalDimensions();
  const width = () =>
    props.width?.() ??
    clampDimension(
      88,
      Math.min(UI_MODAL_MIN_WIDTH, Math.max(1, dims().width - 2)),
      Math.min(props.maxWidth?.() ?? 116, Math.max(1, dims().width - UI_MODAL_HORIZONTAL_MARGIN)),
    );
  const height = () => props.height?.() ?? Math.max(1, Math.floor(dims().height * 0.55));

  return (
    <Show when={props.open()}>
      <Show when={props.dimBackground !== false}>
        <box
          position="absolute"
          zIndex={props.zIndex ?? 3000}
          top={0}
          left={0}
          width={dims().width}
          height={dims().height}
          backgroundColor={MODAL_BACKDROP_COLOR}
          onMouseDown={() => props.onClose?.()}
        />
      </Show>
      <ModalSurface
        width={width}
        height={height}
        top={props.top}
        zIndex={(props.zIndex ?? 3000) + 1}
        onMouseDown={(event) => event.stopPropagation?.()}
      >
        {props.children}
      </ModalSurface>
    </Show>
  );
}

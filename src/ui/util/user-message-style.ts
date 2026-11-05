import { blendHexColors, type ColorsConfig } from "../../config/themes";

export const USER_MESSAGE_BACKGROUND_DIM_WEIGHT = 0.25;

/** Background used by an idle user-message block. */
export function userMessageBackgroundColor(colors: Pick<ColorsConfig, "bg" | "panelUser">): string {
  return blendHexColors(colors.panelUser, colors.bg, USER_MESSAGE_BACKGROUND_DIM_WEIGHT);
}

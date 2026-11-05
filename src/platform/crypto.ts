// effect-shape-allow: platform crypto adapter owns direct node:crypto access.
import { randomUUID } from "node:crypto";

export function uuid(): string {
  return randomUUID();
}

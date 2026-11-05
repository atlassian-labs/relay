import { createStore } from "solid-js/store";
import { createInitialState, type AppState, type ChatBlock } from "../../src/ui/state";
import type { AcpConversationAdapter } from "../../src/application/acp-mapping";

export interface MappingFixture extends AcpConversationAdapter {
  state: AppState;
  setState: (...args: any[]) => void;
}

export function createMappingFixture(cwd = "/tmp/relay-fixture"): MappingFixture {
  const [state, setState] = createStore(createInitialState(cwd));

  return {
    state,
    setState,
    addBlock(block: ChatBlock) {
      setState("blocks", (blocks) => [...blocks, block]);
    },
    updateBlock(id: string, updates: Partial<ChatBlock>) {
      setState("blocks", (block) => block.id === id, updates as any);
    },
    appendToBlock(id: string, text: string) {
      setState(
        "blocks",
        (block) => block.id === id,
        "content" as any,
        (content: string) => `${content ?? ""}${text}`,
      );
    },
    removeBlock(id: string) {
      setState("blocks", (blocks) => blocks.filter((block) => block.id !== id));
    },
    setCurrentBlockId(id: string | null) {
      setState("currentBlockId", id);
    },
  };
}

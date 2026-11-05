import {
  CodeRenderable,
  DiffRenderable,
  MarkdownRenderable,
  type CodeOptions,
  type DiffRenderableOptions,
  type MarkdownOptions,
  type RenderContext,
  type TreeSitterClient,
} from "@opentui/core";
import { extend } from "@opentui/solid";

/**
 * Overrides Solid's syntax-renderable constructors before a renderer is mounted.
 *
 * OpenTUI 0.4.5 accepts a TreeSitter client in the constructors, but the Solid
 * reconciler normally constructs these elements with only an id and assigns JSX
 * properties afterward. Installing constructor wrappers lets tests and benchmarks
 * use the lightweight mock without creating the process-global native client first.
 */
export function installTreeSitterClientOverride(client: TreeSitterClient): void {
  class CodeRenderableWithClient extends CodeRenderable {
    constructor(ctx: RenderContext, options: CodeOptions) {
      super(ctx, { ...options, treeSitterClient: client });
    }
  }

  class DiffRenderableWithClient extends DiffRenderable {
    constructor(ctx: RenderContext, options: DiffRenderableOptions) {
      super(ctx, { ...options, treeSitterClient: client });
    }
  }

  class MarkdownRenderableWithClient extends MarkdownRenderable {
    constructor(ctx: RenderContext, options: MarkdownOptions) {
      super(ctx, { ...options, treeSitterClient: client });
    }
  }

  extend({
    code: CodeRenderableWithClient,
    diff: DiffRenderableWithClient,
    markdown: MarkdownRenderableWithClient,
  });
}

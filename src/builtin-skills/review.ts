import { renderPromptTemplate } from "../core/prompt-template";
import type { Disposable, RelayAutocompleteItem, RelayPluginToastVariant } from "../plugins";
import { getPromptTemplate } from "../prompt-templates";
import { builtinSkillMetadata } from "./metadata";
import { wrapBuiltinSkillPrompt } from "./prompt";
import type { BuiltinSkill } from "./types";

const REVIEW_CONTEXT_PROVIDER_REGISTRY_KEY = Symbol.for("com.atlassian.relay.review.contextProviders");

export interface ReviewContext {
  readonly cwd: string;
  readonly sessionId: string | null;
  readonly threadId: string | null;
  readonly userMessageCount: number;
  readonly running: boolean;
  waitForIdle(): Promise<void>;
  toast(message: string, variant?: RelayPluginToastVariant, durationMs?: number): void;
}

export interface ReviewContextSection {
  readonly title: string;
  readonly content: string;
}

export type ReviewContextProviderResult = ReviewContextSection | readonly ReviewContextSection[] | null | undefined;

export interface ReviewContextProvider {
  readonly id?: string;
  readonly name?: string;
  canResolve?(args: string, ctx: ReviewContext): boolean | Promise<boolean>;
  resolve(args: string, ctx: ReviewContext): ReviewContextProviderResult | Promise<ReviewContextProviderResult>;
  getArgumentCompletions?(
    argsPrefix: string,
    ctx: ReviewContext,
  ): readonly RelayAutocompleteItem[] | Promise<readonly RelayAutocompleteItem[]> | null;
}

interface ReviewContextProviderEntry {
  readonly id: string;
  readonly order: number;
  readonly provider: ReviewContextProvider;
}

interface ReviewContextProviderRegistry {
  readonly providers: Map<string, ReviewContextProviderEntry>;
  order: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isReviewContextProviderRegistry(value: unknown): value is ReviewContextProviderRegistry {
  return isRecord(value) && value.providers instanceof Map && typeof value.order === "number";
}

function registry(): ReviewContextProviderRegistry {
  const existing = Reflect.get(globalThis, REVIEW_CONTEXT_PROVIDER_REGISTRY_KEY);
  if (isReviewContextProviderRegistry(existing)) return existing;

  const created: ReviewContextProviderRegistry = { providers: new Map(), order: 0 };
  Reflect.defineProperty(globalThis, REVIEW_CONTEXT_PROVIDER_REGISTRY_KEY, {
    configurable: true,
    enumerable: false,
    value: created,
  });
  return created;
}

function providerId(provider: ReviewContextProvider): string {
  const id = stringField(provider.id);
  if (id) return id;
  const store = registry();
  store.order += 1;
  return `provider-${store.order}`;
}

export function registerReviewContextProvider(provider: ReviewContextProvider): Disposable {
  const store = registry();
  const id = providerId(provider);
  store.order += 1;
  const entry: ReviewContextProviderEntry = { id, order: store.order, provider };
  store.providers.set(id, entry);
  return {
    dispose() {
      if (store.providers.get(id) === entry) store.providers.delete(id);
    },
  };
}

export function listReviewContextProviders(): readonly ReviewContextProvider[] {
  return [...registry().providers.values()]
    .toSorted((left, right) => left.order - right.order)
    .map((entry) => entry.provider);
}

function normalizeContextSections(contextSections: readonly ReviewContextProviderResult[]): ReviewContextSection[] {
  return contextSections
    .flatMap((result) => (Array.isArray(result) ? result : result ? [result] : []))
    .map((section) => {
      const title = stringField(section.title) ?? "Review Context";
      const content = String(section.content ?? "").trim();
      return content ? { title, content } : null;
    })
    .filter((section): section is ReviewContextSection => section !== null);
}

async function resolveReviewContextSectionsInternal(args: string, ctx: ReviewContext): Promise<ReviewContextSection[]> {
  const sections: ReviewContextProviderResult[] = [];
  for (const provider of listReviewContextProviders()) {
    const canResolve = provider.canResolve ? await provider.canResolve(args, ctx) : true;
    if (!canResolve) continue;
    sections.push(await provider.resolve(args, ctx));
  }
  return normalizeContextSections(sections);
}

export function resolveReviewContextSections(args: string, ctx: ReviewContext): Promise<ReviewContextSection[]> {
  return resolveReviewContextSectionsInternal(args, ctx);
}

function reviewContextText(contextSections: readonly ReviewContextSection[]): string {
  if (contextSections.length === 0) return "";
  return contextSections.map((section) => `\n---\n\n## ${section.title}\n\n${section.content}\n`).join("");
}

export function reviewPrompt(input: string, contextSections: readonly ReviewContextSection[] = []): string {
  const trimmed = input.trim();
  return renderPromptTemplate(getPromptTemplate("review"), {
    input: trimmed,
    arguments: trimmed || "$ARGUMENTS",
    context: reviewContextText(contextSections),
  });
}

const metadata = builtinSkillMetadata("review")!;

export const reviewBuiltinSkill: BuiltinSkill = {
  ...metadata,
  async createPrompt(args, context) {
    const contextSections = await resolveReviewContextSections(args, context);
    return wrapBuiltinSkillPrompt(metadata, reviewPrompt(args, contextSections), args.trim());
  },
};

export function clearReviewContextProvidersForTests(): void {
  const store = registry();
  store.providers.clear();
  store.order = 0;
}

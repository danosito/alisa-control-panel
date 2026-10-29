import type { AnyWidget } from "./types";

const definitions = new Map<string, AnyWidget>();

export function registerWidget(definition: AnyWidget): void {
  if (definitions.has(definition.id)) throw new Error(`Widget already registered: ${definition.id}`);
  definitions.set(definition.id, definition);
}

export function findWidget(id: string): AnyWidget | undefined {
  return definitions.get(id);
}

export function listWidgets(): AnyWidget[] {
  return [...definitions.values()];
}

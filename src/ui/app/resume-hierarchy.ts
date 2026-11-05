export interface ResumeSessionRelation {
  readonly parentSessionId: string;
  readonly childSessionId: string;
}

export interface ResumeHierarchyNode<T> {
  readonly value: T;
  readonly children: readonly ResumeHierarchyNode<T>[];
}

/**
 * Build a provider-neutral forest from an already ordered session list.
 *
 * Relations only connect exact IDs present in the list. Missing, ambiguous,
 * self-referential, and cyclic parent relationships are left as roots rather
 * than inferred or repaired from session content.
 */
export function buildResumeHierarchy<T>(
  values: readonly T[],
  sessionId: (value: T) => string,
  relations: readonly ResumeSessionRelation[],
): ResumeHierarchyNode<T>[] {
  const valueById = new Map<string, T>();
  const orderById = new Map<string, number>();
  for (const [index, value] of values.entries()) {
    const id = sessionId(value);
    if (!id || valueById.has(id)) continue;
    valueById.set(id, value);
    orderById.set(id, index);
  }

  const ambiguousChildren = new Set<string>();
  const parentByChild = new Map<string, string>();
  for (const relation of relations) {
    const parentId = relation.parentSessionId;
    const childId = relation.childSessionId;
    if (
      !parentId ||
      !childId ||
      parentId === childId ||
      !valueById.has(parentId) ||
      !valueById.has(childId) ||
      ambiguousChildren.has(childId)
    ) {
      continue;
    }
    const existingParent = parentByChild.get(childId);
    if (existingParent === undefined || existingParent === parentId) {
      parentByChild.set(childId, parentId);
      continue;
    }
    parentByChild.delete(childId);
    ambiguousChildren.add(childId);
  }

  // Break every member of a cycle into a root. Descendants outside the cycle
  // can still remain attached to those now-root nodes.
  for (const startId of valueById.keys()) {
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let currentId: string | undefined = startId;
    while (currentId !== undefined) {
      const cycleStart = pathIndex.get(currentId);
      if (cycleStart !== undefined) {
        for (const cycleId of path.slice(cycleStart)) parentByChild.delete(cycleId);
        break;
      }
      pathIndex.set(currentId, path.length);
      path.push(currentId);
      currentId = parentByChild.get(currentId);
    }
  }

  const childIdsByParent = new Map<string, string[]>();
  for (const [childId, parentId] of parentByChild) {
    const childIds = childIdsByParent.get(parentId) ?? [];
    childIds.push(childId);
    childIdsByParent.set(parentId, childIds);
  }

  const subtreeRank = new Map<string, number>();
  function rank(id: string): number {
    const cached = subtreeRank.get(id);
    if (cached !== undefined) return cached;
    let result = orderById.get(id) ?? Number.MAX_SAFE_INTEGER;
    for (const childId of childIdsByParent.get(id) ?? []) result = Math.min(result, rank(childId));
    subtreeRank.set(id, result);
    return result;
  }

  const compareIds = (left: string, right: string): number => {
    const rankDifference = rank(left) - rank(right);
    if (rankDifference !== 0) return rankDifference;
    return (orderById.get(left) ?? Number.MAX_SAFE_INTEGER) - (orderById.get(right) ?? Number.MAX_SAFE_INTEGER);
  };

  function node(id: string): ResumeHierarchyNode<T> {
    return {
      value: valueById.get(id)!,
      children: [...(childIdsByParent.get(id) ?? [])].sort(compareIds).map(node),
    };
  }

  return [...valueById.keys()]
    .filter((id) => !parentByChild.has(id))
    .sort(compareIds)
    .map(node);
}

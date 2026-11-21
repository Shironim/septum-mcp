/** Accumulate all mount paths at each router before propagating them to descendants. */
export function composeMountPrefixes<Key>(
  roots: ReadonlyMap<Key, string | undefined>,
  mounts: ReadonlyArray<{ parent: Key; child: Key; prefix: string | undefined }>,
  signal?: AbortSignal,
): Map<Key, Set<string>> {
  const children = new Map<Key, typeof mounts[number][]>();
  const incoming = new Map<Key, number>();
  for (const mount of mounts) {
    const edges = children.get(mount.parent) ?? [];
    edges.push(mount);
    children.set(mount.parent, edges);
    incoming.set(mount.child, (incoming.get(mount.child) ?? 0) + 1);
  }

  const prefixes = new Map<Key, Set<string>>();
  const queue: Key[] = [];
  for (const [key, prefix] of roots) {
    if (incoming.has(key)) continue;
    queue.push(key);
    prefixes.set(key, new Set(prefix === undefined ? [] : [prefix]));
  }
  for (let index = 0; index < queue.length; index++) {
    signal?.throwIfAborted();
    const parent = queue[index]!;
    for (const edge of children.get(parent) ?? []) {
      const paths = prefixes.get(edge.child) ?? new Set<string>();
      if (edge.prefix !== undefined) {
        for (const path of prefixes.get(parent) ?? []) {
          signal?.throwIfAborted();
          paths.add(path + edge.prefix);
        }
      }
      prefixes.set(edge.child, paths);
      const remaining = incoming.get(edge.child)! - 1;
      incoming.set(edge.child, remaining);
      if (!remaining) queue.push(edge.child);
    }
  }
  // Cycles (and routes depending on them) have no complete registration path.
  for (const [key, remaining] of incoming) if (remaining) prefixes.delete(key);
  return prefixes;
}

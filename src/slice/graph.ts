/**
 * The graph a graphify run writes to `graph.json`, as the slice walk reads
 * it. Only what the walk needs is kept: a node's file, community and
 * dependency status, and a link's endpoints, relation and confidence.
 *
 * Node ids are the driver's: `file:<path>`, `symbol:<path>:<name>` and, for
 * an import the compiler could not resolve to a repository file,
 * `dependency:<path>:<specifier>`. A node's `source_file` is the repository
 * path it was read from, which is how a symbol is mapped back to its file.
 */

export type SliceNodeKind = "file" | "symbol" | "dependency" | "other";

export interface SliceGraphNode {
  readonly id: string;
  readonly kind: SliceNodeKind;
  readonly label: string;
  /** Repository-relative path, `/`-separated. */
  readonly sourceFile: string;
  readonly community: number | null;
  /** Only on `dependency` nodes: a package, or an import nothing resolved. */
  readonly dependencyStatus: "external" | "unresolved" | null;
  /** The line the driver read it at (`source_location` `L<n>`), when it says. */
  readonly line: number | null;
}

export interface SliceGraphLink {
  readonly source: string;
  readonly target: string;
  readonly relation: string;
  /** `EXTRACTED` for an AST fact; anything else is inferred or ambiguous. */
  readonly confidence: string;
  /** The import's text, when the link is an import; null for a dynamic one. */
  readonly specifier: string | null;
  readonly location: string | null;
}

export interface SliceGraph {
  readonly nodes: readonly SliceGraphNode[];
  readonly links: readonly SliceGraphLink[];
  /** Community id to the node ids in it. */
  readonly communities: ReadonlyMap<number, readonly string[]>;
}

export class SliceGraphError extends Error {
  constructor(detail: string) {
    super(`Not a graphify graph: ${detail}`);
  }
}

export function nodeKind(id: string): SliceNodeKind {
  if (id.startsWith("file:")) return "file";
  if (id.startsWith("symbol:")) return "symbol";
  if (id.startsWith("dependency:")) return "dependency";
  return "other";
}

/**
 * The repository path an entry point names, without the graph: the file of
 * a `file:` or `symbol:` node id, or the entry itself, which is then a path.
 * A `dependency:` id names no file, so null. The slice walk resolves ids
 * against the graph (`reach`); this is for readers that only have the tree,
 * such as the pricing profile mapping entry points to modules. A symbol's
 * name is what follows the first colon after its path, since a name such as
 * `Type::method` may hold colons where a path rarely does.
 */
export function entryPointPath(entry: string): string | null {
  switch (nodeKind(entry)) {
    case "file":
      return entry.slice("file:".length);
    case "symbol": {
      const rest = entry.slice("symbol:".length);
      const colon = rest.indexOf(":");
      return colon === -1 ? rest : rest.slice(0, colon);
    }
    case "dependency":
      return null;
    case "other":
      return entry;
  }
}

/** The file a node belongs to; a dependency placeholder belongs to none. */
export function fileOf(node: SliceGraphNode): string | null {
  return node.kind === "file" || node.kind === "symbol"
    ? node.sourceFile
    : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Reads the driver's canonical graph; a shape mismatch is a loud error. */
export function parseSliceGraph(value: unknown): SliceGraph {
  if (!isRecord(value)) throw new SliceGraphError("not an object");
  if (!Array.isArray(value["nodes"]) || !Array.isArray(value["links"]))
    throw new SliceGraphError("nodes and links must be arrays");
  const nodes: SliceGraphNode[] = [];
  const ids = new Set<string>();
  for (const raw of value["nodes"]) {
    if (!isRecord(raw) || typeof raw["id"] !== "string")
      throw new SliceGraphError("a node has no id");
    const id = raw["id"];
    if (ids.has(id)) throw new SliceGraphError(`duplicate node ${id}`);
    ids.add(id);
    const sourceFile = raw["source_file"];
    if (typeof sourceFile !== "string" || sourceFile === "")
      throw new SliceGraphError(`node ${id} has no source_file`);
    const community = raw["community"];
    const status = raw["dependencyStatus"];
    const location = raw["source_location"];
    const line =
      typeof location === "string" ? /^L(\d+)$/.exec(location)?.[1] : undefined;
    nodes.push({
      id,
      kind: nodeKind(id),
      label: typeof raw["label"] === "string" ? raw["label"] : id,
      sourceFile,
      community:
        typeof community === "number" && Number.isInteger(community)
          ? community
          : null,
      dependencyStatus:
        status === "external" || status === "unresolved" ? status : null,
      line: line === undefined ? null : Number(line),
    });
  }
  const links: SliceGraphLink[] = [];
  for (const raw of value["links"]) {
    if (
      !isRecord(raw) ||
      typeof raw["source"] !== "string" ||
      typeof raw["target"] !== "string" ||
      typeof raw["relation"] !== "string"
    )
      throw new SliceGraphError("a link lacks source, target or relation");
    if (!ids.has(raw["source"]) || !ids.has(raw["target"]))
      throw new SliceGraphError("a link names an unknown node");
    links.push({
      source: raw["source"],
      target: raw["target"],
      relation: raw["relation"],
      confidence:
        typeof raw["confidence"] === "string" ? raw["confidence"] : "EXTRACTED",
      specifier: typeof raw["specifier"] === "string" ? raw["specifier"] : null,
      location:
        typeof raw["source_location"] === "string"
          ? raw["source_location"]
          : null,
    });
  }
  const communities = new Map<number, string[]>();
  const rawCommunities = value["communities"];
  if (rawCommunities !== undefined) {
    if (!isRecord(rawCommunities))
      throw new SliceGraphError("communities must be an object");
    for (const [key, members] of Object.entries(rawCommunities)) {
      const community = Number(key);
      if (
        !Number.isInteger(community) ||
        !Array.isArray(members) ||
        !members.every((member) => typeof member === "string")
      )
        throw new SliceGraphError(`community ${key} is malformed`);
      communities.set(community, [...(members as string[])].sort());
    }
  }
  return { nodes, links, communities };
}

/**
 * The import graph of a checkout, as the slice walk reads it.
 *
 * Node ids: `file:<path>` for a file of the checkout, and
 * `dependency:<path>:<specifier>` for an import from `<path>` that resolves
 * to no file of it (a package, a path that misses, a computed name). A
 * node's `sourceFile` is the repository path it was read from.
 *
 * Each link is one import, re-export or reference as the source wrote it,
 * with the names it takes, so the walk can follow a barrel only to the
 * modules that supply those names, and pass over an import of types.
 */

export type SliceNodeKind = "file" | "dependency";

/** The names a file declares and exports itself, read from its syntax. */
export interface FileExports {
  /** Names that exist at runtime, `default` among them. */
  readonly values: readonly string[];
  /** Interfaces and type aliases, which the compiler erases. */
  readonly types: readonly string[];
}

export interface SliceGraphNode {
  readonly id: string;
  readonly kind: SliceNodeKind;
  readonly label: string;
  /** Repository-relative path, `/`-separated. */
  readonly sourceFile: string;
  /** Only on `dependency` nodes: a package, an import nothing resolved, or
   * a literal path read at runtime that is no file a slice can copy. */
  readonly dependencyStatus: "external" | "unresolved" | "path" | null;
  /** On a script's `file` node: its own exports; null when not known
   * (`export =`, or a file that is not a script). */
  readonly exports: FileExports | null;
}

/**
 * - `imports`: an import, re-export, `require` or `import()` of a literal.
 * - `references`: a module named to a test runner or a resolver
 *   (`vi.mock`, `jest.requireActual`, `require.resolve`), which needs the
 *   module to exist but never loads its code into the slice.
 * - `reads`: a file read by a literal path at runtime
 *   (`new URL("./x", import.meta.url)`, `join(__dirname, "x")`), which needs
 *   the file itself at that path.
 */
export type SliceRelation = "imports" | "references" | "reads";

export interface SliceGraphLink {
  readonly source: string;
  readonly target: string;
  readonly relation: SliceRelation;
  /** The text as written, for an import or a reference; null otherwise. */
  readonly specifier: string | null;
  /** `L<n>`, the line it is on. */
  readonly location: string | null;
  /** `import type`, `export type`, `import("x").T`: erased at runtime. */
  readonly typeOnly: boolean;
  /** The names it takes, or null for the whole module. */
  readonly names: readonly string[] | null;
  /**
   * For `export ... from`, what it forwards as [name in the module, name
   * exported]: `*` for `export *`, `["*", "ns"]` for `export * as ns`.
   * Null for anything else.
   */
  readonly forwards: readonly (readonly [string, string])[] | "*" | null;
}

export interface SliceGraph {
  readonly nodes: readonly SliceGraphNode[];
  readonly links: readonly SliceGraphLink[];
}

export function nodeKind(id: string): SliceNodeKind | null {
  if (id.startsWith("file:")) return "file";
  if (id.startsWith("dependency:")) return "dependency";
  return null;
}

/** The file a node belongs to; a dependency placeholder belongs to none. */
export function fileOf(node: SliceGraphNode): string | null {
  return node.kind === "file" ? node.sourceFile : null;
}

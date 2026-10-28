/**
 * What a slice reaches outside the repository: the service SDKs and HTTP
 * clients its files import, and the environment variables they read. Listed
 * by name so the sandbox phase knows what to mock; values are never read.
 *
 * A fixed table over import specifiers plus a regex pass over the text, so
 * the result is the same for the same bytes. The regexes are deliberately
 * simple: a false positive costs one spurious line in a list a person reads;
 * a parser per language would cost a dependency per language.
 */

export interface ExternalServiceRule {
  /** A neutral name for the service family: `aws`, `postgres`, `http`. */
  readonly service: string;
  /** Exact specifiers, or a scope prefix ending in `/*`. */
  readonly specifiers: readonly string[];
}

export const EXTERNAL_SERVICE_RULES: readonly ExternalServiceRule[] = [
  {
    service: "aws",
    specifiers: ["@aws-sdk/*", "aws-sdk", "boto3", "botocore"],
  },
  // Not PyGithub: it is installed under that name but imported as
  // `github`, and `github` would also match every Go import from
  // `github.com/...`, since non-Python files share one import pattern.
  { service: "github", specifiers: ["@octokit/*", "octokit"] },
  { service: "google", specifiers: ["googleapis", "@google-cloud/*"] },
  { service: "stripe", specifiers: ["stripe"] },
  {
    service: "postgres",
    specifiers: [
      "pg",
      "postgres",
      "pg-promise",
      "psycopg",
      "psycopg2",
      "asyncpg",
    ],
  },
  { service: "mysql", specifiers: ["mysql", "mysql2", "pymysql"] },
  { service: "sqlite", specifiers: ["better-sqlite3", "sqlite3"] },
  { service: "mongodb", specifiers: ["mongodb", "mongoose", "pymongo"] },
  { service: "redis", specifiers: ["ioredis", "redis"] },
  {
    service: "orm",
    specifiers: ["@prisma/client", "sqlalchemy", "drizzle-orm"],
  },
  {
    service: "http",
    specifiers: [
      "axios",
      "node-fetch",
      "got",
      "undici",
      "ky",
      "superagent",
      "requests",
      "httpx",
      "aiohttp",
    ],
  },
  {
    service: "email",
    specifiers: ["nodemailer", "@sendgrid/*", "resend", "postmark"],
  },
  { service: "queue", specifiers: ["bullmq", "amqplib", "kafkajs", "pika"] },
  {
    service: "llm",
    specifiers: ["@anthropic-ai/*", "anthropic", "openai"],
  },
  { service: "twilio", specifiers: ["twilio"] },
  { service: "slack", specifiers: ["@slack/*", "slack_sdk"] },
];

export interface ExternalPackage {
  readonly specifier: string;
  readonly service: string;
  /** Included files importing it, sorted. */
  readonly files: readonly string[];
}

export interface EnvironmentRead {
  readonly name: string;
  readonly files: readonly string[];
}

export interface SliceExternals {
  readonly packages: readonly ExternalPackage[];
  readonly environment: readonly EnvironmentRead[];
}

export interface ExternalsInput {
  readonly path: string;
  readonly text: string;
}

/** The service a specifier belongs to, or null when the table has none. */
export function serviceOf(specifier: string): string | null {
  for (const rule of EXTERNAL_SERVICE_RULES)
    for (const pattern of rule.specifiers) {
      if (pattern.endsWith("/*")) {
        const scope = pattern.slice(0, -1);
        if (specifier.startsWith(scope)) return rule.service;
      } else if (
        specifier === pattern ||
        specifier.startsWith(`${pattern}/`) ||
        specifier.startsWith(`${pattern}.`)
      )
        return rule.service;
    }
  return null;
}

const IMPORT_PATTERNS: readonly RegExp[] = [
  /\bimport\s+(?:[^'";]*?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /\bexport\s+[^'";]*?\s+from\s+['"]([^'"\n]+)['"]/g,
  /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];
/**
 * Python's forms, for Python files only: on a script line such as
 * `import got from "./got.js"` they would read `got` as a module.
 */
const PYTHON_IMPORT_PATTERNS: readonly RegExp[] = [
  /^\s*import\s+([\w.]+)/gm,
  /^\s*from\s+([\w.]+)\s+import\b/gm,
];

const ENVIRONMENT_PATTERNS: readonly RegExp[] = [
  /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /\bprocess\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /\bDeno\.env\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g,
  /\bos\.environ\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /\bos\.environ\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /\bos\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
];

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function matches(text: string, patterns: readonly RegExp[]): Set<string> {
  const found = new Set<string>();
  for (const pattern of patterns) {
    const expression = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(expression)) {
      const value = match[1];
      if (value !== undefined) found.add(value);
    }
  }
  return found;
}

export function detectExternals(
  files: readonly ExternalsInput[],
): SliceExternals {
  const packages = new Map<string, { service: string; files: Set<string> }>();
  const environment = new Map<string, Set<string>>();
  for (const file of files) {
    const patterns = /\.pyi?$/.test(file.path)
      ? PYTHON_IMPORT_PATTERNS
      : IMPORT_PATTERNS;
    for (const specifier of matches(file.text, patterns)) {
      const service = serviceOf(specifier);
      if (service === null) continue;
      const entry = packages.get(specifier) ?? { service, files: new Set() };
      entry.files.add(file.path);
      packages.set(specifier, entry);
    }
    for (const name of matches(file.text, ENVIRONMENT_PATTERNS)) {
      const entry = environment.get(name) ?? new Set();
      entry.add(file.path);
      environment.set(name, entry);
    }
  }
  return {
    packages: [...packages.entries()]
      .sort(([a], [b]) => compare(a, b))
      .map(([specifier, entry]) => ({
        specifier,
        service: entry.service,
        files: [...entry.files].sort(compare),
      })),
    environment: [...environment.entries()]
      .sort(([a], [b]) => compare(a, b))
      .map(([name, paths]) => ({ name, files: [...paths].sort(compare) })),
  };
}

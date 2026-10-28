/**
 * Secrets: the credentials a source repository can hold in its text (a
 * private key, a cloud or API token, a password assigned in code) and the
 * files that exist to hold them (`.env`, `*.pem`, a service-account JSON).
 *
 * A sandbox is cut from a private repository, so a slice that reaches a
 * secret-named file is refused, and a build scans every public file it
 * generates and blocks on what it finds. A finding names its rule, file and
 * line, never the value: a blocker is shown to the people and agents the
 * value must not reach.
 *
 * Provider rules match a token's own shape (an `Authorization: Bearer`
 * header's and an `.npmrc` `_authToken`'s too), and skip one only when what
 * follows its prefix is a placeholder as a whole (`ghp_xxxx…`, `${TOKEN}`,
 * `<token>`, `your-token-here`, AWS's documented `…EXAMPLE` keys): a real
 * token can hold `Test` by chance or by its owner's choice. A URL's password
 * (`postgres://app:…@db`) counts unless it is empty, a template or such a
 * placeholder (`user:password@`).
 *
 * The generic rule needs a name whose last word says secret (`apiKey`,
 * `DB_PASSWORD`, `client_secret`, not `tokenizerModel` or
 * `passwordResetPath`) assigned a long literal of high entropy with letters
 * and digits, and skips values with a placeholder word in them (`fixture`,
 * `test`, `your`) and values that read as a path, an ARN or words joined
 * (`token-refresh-queue-v2`, `gpt-4o-mini-2024-07-18`). A password-named
 * literal of letters alone (`correcthorsebatterystaple`) counts too unless
 * it is shaped like an identifier. An environment read is not a literal, so
 * it never matches, but its fallback (`process.env.API_KEY ?? "…"`) is. A
 * hex value under a name that says it is a hash (`tokenHash`,
 * `secretDigest`) is a digest, not a credential.
 */

import type { ProjectBlocker } from "./project.js";

export const SECRET_RULES = [
  "private-key",
  "aws-access-key-id",
  "github-token",
  "gitlab-token",
  "npm-token",
  "slack-token",
  "stripe-live-key",
  "google-api-key",
  "google-service-account",
  "sendgrid-key",
  "huggingface-token",
  "jwt",
  "anthropic-key",
  "openai-key",
  "bearer-token",
  "url-credentials",
  "generic-secret",
] as const;
export type SecretRule = (typeof SECRET_RULES)[number];

export interface SecretFinding {
  readonly rule: SecretRule;
  readonly file: string;
  /** 1-based. */
  readonly line: number;
}

/** Findings a blocker's detail names before it counts the rest. */
const FINDINGS_SHOWN = 5;
/** Shortest literal the generic rule considers. */
const GENERIC_MIN_LENGTH = 16;
/** Bits per character below which a literal reads as words, not a key. */
const GENERIC_MIN_ENTROPY = 3.5;

/** Words that make a generic literal documentation or a fixture. */
const PLACEHOLDER =
  /example|sample|placeholder|changeme|change_me|dummy|fake|fixture|mock|redacted|your|xxxx|\*\*\*|<|>|\$\{|\{\{|test|sandbox|todo|insert|replace/i;

/** Rules that match a provider's token shape anywhere in the text. */
const TOKEN_RULES: readonly { rule: SecretRule; pattern: RegExp }[] = [
  { rule: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    rule: "github-token",
    pattern: /\b(?:gh[opsur]_[A-Za-z0-9]{36,255}|github_pat_\w{22,255})\b/g,
  },
  { rule: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { rule: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { rule: "slack-token", pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
  { rule: "stripe-live-key", pattern: /\b[rs]k_live_[A-Za-z0-9]{10,}/g },
  { rule: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}(?![\w-])/g },
  {
    rule: "sendgrid-key",
    pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![\w-])/g,
  },
  { rule: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{34,}\b/g },
  {
    rule: "jwt",
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  { rule: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    rule: "openai-key",
    pattern:
      /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{48}\b)/g,
  },
];

/** `Bearer <token>`, as a header or a request in the docs carries one. */
const BEARER = /\b[Bb]earer[ \t]+([A-Za-z0-9._~+/-]{20,}=*)/g;
/**
 * An `.npmrc` `_authToken` or `_auth`, global or a registry's
 * (`//host/:_authToken=`), whatever its shape: npm's are UUIDs too.
 */
const NPM_AUTH = /(?:^|:)_auth(?:Token)?[ \t]*=[ \t]*([^\s"'`#;]+)/gm;
/** A provider's prefix (`ghp_`, `sk_live_`, `AKIA`), left off a token's body. */
const TOKEN_PREFIX = /^(?:AKIA|ASIA|AIza|SG\.|(?:[a-z]+[_-])+)/i;
/**
 * A value that is a placeholder as a whole: one character repeated or only
 * `x`, `0` and `*`, a template (`<token>`, `${TOKEN}`, `$TOKEN`, `{{token}}`),
 * `changeme`, `password`, `your-…-here`, or AWS's documented `…EXAMPLE`.
 */
const PLACEHOLDER_VALUE =
  /^(?:(.)\1*|[x0*.]+|<[^<>]*>|\$\{[^{}]*\}|\$[a-z_]\w*|\{\{[^{}]*\}\}|change_?me|password|your[-_][\w-]*[-_]here|\w*example)$/i;

/** A PEM header; the block counts only with a base64 body after it. */
const PRIVATE_KEY_HEADER =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;
const KEY_BODY = /[A-Za-z0-9+/]{40,}/;

/**
 * A name whose last word says it holds a secret: `apiKey`, `DB_PASSWORD`,
 * `client_secret`, `SECRET_KEY`. A word that goes on (`tokenizer`,
 * `passwordResetPath`, `TOKEN_REFRESH_QUEUE`, `secretArn`) names something
 * else.
 */
const SECRET_NAME =
  "[\\w.$-]*?(?:password|passwd|passphrase|pwd|secret|token|(?:api|access|auth|private|secret|signing|encryption|master)[_-]?key|secret[_-]?key[_-]?base)(?![\\w$-])";
/** A secret name whose last word says password: its value may be words. */
const PASSWORD_NAME = /(?:password|passwd|passphrase|pwd)$/i;
/** A passphrase's shape: letters alone, long enough not to be a word. */
const PASSPHRASE = /^[A-Za-z]{16,}$/;
/** An identifier's shape (`passwordInput`, `ResetPassword`), not a phrase's. */
const IDENTIFIER_SHAPE = /^[A-Za-z][a-z]+(?:[A-Z][a-z]+)+$/;
/**
 * `name = "value"`, `name: 'value'`, `"name": "value"`, and typed,
 * `name: string = "value"`, anywhere on a line.
 */
const QUOTED_ASSIGNMENT = new RegExp(
  `(${SECRET_NAME})["']?(?:\\s*:\\s*[A-Za-z_$][\\w$.<>\\[\\]]*)?\\s*(?::=|=>|[:=])\\s*(["'\`])([^"'\`\\n]+)\\2`,
  "gi",
);
/**
 * `NAME=value` or `name: value` alone on a line, as env and YAML files have
 * it, a trailing `# comment` aside.
 */
const BARE_ASSIGNMENT = new RegExp(
  `^[ \\t]*(?:export[ \\t]+|-[ \\t]+)?(${SECRET_NAME})[ \\t]*[:=][ \\t]*([^\\s"'\`#]+)[ \\t]*(?:#.*)?$`,
  "gim",
);
/** A literal a secret-named read falls back to: `env.API_KEY ?? "value"`. */
const FALLBACK_ASSIGNMENT = new RegExp(
  `(${SECRET_NAME})[^"'\`\\n]*?(?:\\?\\?|\\|\\|)\\s*(["'\`])([^"'\`\\n]+)\\2`,
  "gi",
);
/** A name word that says its value is a digest of something, not the thing. */
const DIGEST_WORD =
  /^(?:hash|hashed|digest|checksum|integrity|fingerprint|sha\d*)$/;
const HEX_DIGEST = /^(?:sha\d+[:-])?[0-9a-f]+$/i;
/** A path (`/account/reset`, `./keys`) or an AWS resource name. */
const PATH_OR_ARN = /^(?:\.{0,2}\/|~\/|arn:)/;
/**
 * A part of words joined (`token-refresh-queue-v2`, `gpt-4o-mini-2024-07-18`,
 * `1.2.3`): a word, a number, or a part too short to hold a secret.
 */
const WORD_PART = /^(?:[A-Za-z][a-z]*|[A-Z]+|\d+|[A-Za-z\d]{1,3})$/;

/** `scheme://user:password@host`; the user may be empty, the password not. */
const URL_CREDENTIALS =
  /\b[a-z][a-z0-9+.-]*:\/\/([^\s:/@"'`]*):([^\s/@"'`]+)@[\w[]/gi;
/** Passwords that stand for one in documentation and local defaults. */
const URL_PASSWORD_PLACEHOLDER =
  /^(?:pass(?:word)?|passwd|pwd|pw|secret|admin|root|guest|user(?:name)?|postgres|mysql|redis|token|[x*.]+)$/i;

/** Shannon entropy of a string, in bits per character. */
export function entropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Whether a name's words (`tokenHash`, `TOKEN_SHA256`) say it holds a digest. */
function digestName(name: string): boolean {
  return name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .some((word) => DIGEST_WORD.test(word));
}

/** Whether a value reads as a path, an ARN or words joined, not a key. */
function identifierLike(value: string): boolean {
  if (PATH_OR_ARN.test(value)) return true;
  const parts = value.split(/[-._/]/);
  return parts.length > 1 && parts.every((part) => WORD_PART.test(part));
}

/** Whether a token's body, past its provider's prefix, is a placeholder. */
function placeholderToken(token: string): boolean {
  return PLACEHOLDER_VALUE.test(token.replace(TOKEN_PREFIX, ""));
}

/** Whether a literal assigned to `name` looks like a generated credential. */
function secretLike(name: string, value: string): boolean {
  if (
    value.length < GENERIC_MIN_LENGTH ||
    /\s|:\/\//.test(value) ||
    PLACEHOLDER.test(value) ||
    PLACEHOLDER_VALUE.test(value) ||
    identifierLike(value)
  )
    return false;
  if (PASSWORD_NAME.test(name) && PASSPHRASE.test(value))
    return !IDENTIFIER_SHAPE.test(value);
  return (
    !(HEX_DIGEST.test(value) && digestName(name)) &&
    /[A-Za-z]/.test(value) &&
    /\d/.test(value) &&
    entropy(value) >= GENERIC_MIN_ENTROPY
  );
}

/** Whether a URL's password is one, not a template or placeholder. */
function urlPasswordLike(user: string, password: string): boolean {
  return (
    password !== user &&
    !/[$%{}<>]/.test(password) &&
    !URL_PASSWORD_PLACEHOLDER.test(password) &&
    !PLACEHOLDER_VALUE.test(password)
  );
}

/** Each secret found in each file's text, by file, line and rule. */
export function scanSecrets(
  files: readonly { readonly path: string; readonly text: string }[],
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    const { text } = file;
    const starts = [0];
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1))
      starts.push(i + 1);
    const lineAt = (index: number) => {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if ((starts[mid] ?? 0) <= index) low = mid;
        else high = mid - 1;
      }
      return low + 1;
    };
    const seen = new Set<string>();
    const found = (rule: SecretRule, index: number) => {
      const line = lineAt(index);
      const key = `${rule}:${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({ rule, file: file.path, line });
    };
    for (const match of text.matchAll(PRIVATE_KEY_HEADER)) {
      const after = text
        .slice(match.index + match[0].length, match.index + 400)
        .replace(/\\n|\s/g, "");
      if (KEY_BODY.test(after)) found("private-key", match.index);
    }
    for (const { rule, pattern } of TOKEN_RULES)
      for (const match of text.matchAll(pattern))
        if (!placeholderToken(match[0])) found(rule, match.index);
    for (const match of text.matchAll(BEARER)) {
      const token = match[1] ?? "";
      if (
        /\d/.test(token) &&
        /[A-Za-z]/.test(token) &&
        !PLACEHOLDER_VALUE.test(token) &&
        !identifierLike(token)
      )
        found("bearer-token", match.index);
    }
    for (const match of text.matchAll(NPM_AUTH))
      if (!PLACEHOLDER_VALUE.test(match[1] ?? ""))
        found("npm-token", match.index);
    const serviceKey = /"private_key"\s*:\s*"[^"]{20,}/.exec(text);
    if (serviceKey !== null && /"client_email"\s*:/.test(text))
      found("google-service-account", serviceKey.index);
    for (const match of text.matchAll(URL_CREDENTIALS))
      if (urlPasswordLike(match[1] ?? "", match[2] ?? ""))
        found("url-credentials", match.index);
    for (const pattern of [QUOTED_ASSIGNMENT, FALLBACK_ASSIGNMENT])
      for (const match of text.matchAll(pattern))
        if (secretLike(match[1] ?? "", match[3] ?? ""))
          found("generic-secret", match.index);
    // A call (`token: z.string().min(1),`) is code, not a value: no
    // generated credential has parentheses.
    for (const match of text.matchAll(BARE_ASSIGNMENT))
      if (!/[()]/.test(match[2] ?? "") && secretLike(match[1] ?? "", match[2] ?? ""))
        found("generic-secret", match.index);
  }
  return findings.sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      SECRET_RULES.indexOf(a.rule) - SECRET_RULES.indexOf(b.rule),
  );
}

/**
 * Files that exist to hold credentials: environment files (`.env`,
 * `.env.local`, `.env-prod`, `prod.env`, direnv's `.envrc`), keys and
 * keystores, SSH identities, credential, service-account, admin SDK and
 * key JSON, secrets files (`secrets.yml`, `app.secrets.json`), Terraform
 * variables, kubeconfigs, AWS shared credentials and Docker's and Kubernetes'
 * client configuration, and npm, PyPI, Git, Postgres and netrc credential
 * files (which carry registry, host and database passwords). Matched on the
 * basename, case-insensitively, except `.aws/credentials`,
 * `.docker/config.json` and `.kube/config`, path suffixes. An environment
 * template (`.env.example`, `.env.local.sample`, `.env-template`) documents
 * keys, not values, so it is not one; its text is scanned like any other.
 * No slice may include one, and no agent tool reads one.
 */
export function isSecretPath(path: string): boolean {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  const under = (suffix: string) =>
    lower === suffix || lower.endsWith(`/${suffix}`);
  // Key JSON is matched on the stem, without `.*\.json$`: that pattern
  // backtracks polynomially on a long name of repeated keywords.
  const jsonStem = name.endsWith(".json") ? name.slice(0, -5) : null;
  const firebase = jsonStem?.indexOf("firebase") ?? -1;
  return (
    (/^\.env(?:[.-]|$)|\.env$/.test(name) &&
      !/[.-](?:example|sample|template)$/.test(name)) ||
    name === ".envrc" ||
    name === ".npmrc" ||
    name === ".netrc" ||
    name === "_netrc" ||
    name === ".pypirc" ||
    name === ".pgpass" ||
    name === ".git-credentials" ||
    /\.(?:pem|key|p8|p12|pfx|ppk|jks|keystore)$/.test(name) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)/.test(name) ||
    (jsonStem !== null &&
      (/credentials|service[-_]?account|adminsdk|(?:^|[-_.])key$/.test(
        jsonStem,
      ) ||
        (firebase >= 0 && jsonStem.includes("key", firebase + 8)))) ||
    /(?:^|\.)secrets\.(?:json|ya?ml|toml)$/.test(name) ||
    /\.tfvars(?:\.json)?$/.test(name) ||
    /^kubeconfig(?:[-_][\w-]+)?(?:\.ya?ml)?$|\.kubeconfig$/.test(name) ||
    under(".aws/credentials") ||
    under(".docker/config.json") ||
    under(".kube/config")
  );
}

/** A blocker for each file with findings, naming lines and rules, never values. */
export function secretBlockers(
  findings: readonly SecretFinding[],
): ProjectBlocker[] {
  const byFile = new Map<string, SecretFinding[]>();
  for (const finding of findings)
    byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
  return [...byFile.entries()].map(([file, list]) => {
    const shown = list
      .slice(0, FINDINGS_SHOWN)
      .map((finding) => `${file}:${finding.line} (${finding.rule})`)
      .join(", ");
    const rest = list.length - FINDINGS_SHOWN;
    return {
      code: "secret_found",
      file,
      detail: `A credential appears at ${shown}${rest > 0 ? `, and ${rest} more` : ""}. Remove it or replace it with a fixture value.`,
    };
  });
}

/**
 * The local toolchain every carved-out project declares. Fixed per tool
 * version so two cuts of one slice are byte-identical.
 */

export interface Toolchain {
  /** `.nvmrc` content. */
  readonly node: string;
  /** `engines.node`. */
  readonly nodeRange: string;
  readonly npm: string;
  readonly typescript: string;
  readonly testRunner: "node:test";
  readonly supportedPlatforms: readonly ("darwin" | "linux" | "win32")[];
}

export const SANDBOX_TOOLCHAIN: Toolchain = {
  node: "22",
  nodeRange: ">=22.12.0",
  npm: "10.9.2",
  typescript: "5.9.3",
  testRunner: "node:test",
  supportedPlatforms: ["darwin", "linux", "win32"],
};

/** The commands a contributor runs, with or without the extension. */
export const SANDBOX_COMMANDS = {
  install: "npm ci",
  dev: "npm run dev",
  build: "npm run build",
  test: "npm test",
} as const;
export type SandboxCommand = keyof typeof SANDBOX_COMMANDS;

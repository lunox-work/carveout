/**
 * The recording mock runtime every generated module and mock package
 * imports (`carveout/mock.js`), and its declarations (`carveout/mock.d.ts`),
 * as text. Pure: no Node module and no compiler.
 */

/** The runtime itself, written at the harness's `mock.js`. */
export const MOCK_RUNTIME = `// The recording mock every generated module and package shares.
//
// A mock answers any property with another mock, any call with a mock and
// records the call. It is not thenable, so awaiting one gives the mock
// back, and it prints as [mock <name>]. Tests can install an implementation
// for a path with mockImplementation() and read what was called with
// recordedCalls(). Nothing here reaches a network or a credential.
const calls = [];
const implementations = new Map();
const fixtures = new Map();
export function recordedCalls() {
  return calls.slice();
}
/** Clears recorded calls and installed implementations; fixtures stay. */
export function resetMocks() {
  calls.length = 0;
  implementations.clear();
}
/** @param {string} path such as "module:lib/service.ts.createService" */
export function mockImplementation(path, implementation) {
  implementations.set(path, implementation);
}
/** The task's default behaviour for a path; mockImplementation() overrides it. */
export function fixture(path, implementation) {
  fixtures.set(path, implementation);
}
export function createMock(origin, name = origin) {
  const target = function mock() {};
  return new Proxy(target, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (property === Symbol.toPrimitive) return () => \`[mock \${name}]\`;
      if (property === Symbol.iterator) return function* iterate() {};
      if (property === "toJSON") return () => ({ mock: name });
      if (typeof property === "symbol") return undefined;
      return createMock(origin, \`\${name}.\${property}\`);
    },
    apply(_target, _self, args) {
      calls.push({ name, args });
      const implementation = implementations.get(name) ?? fixtures.get(name);
      return implementation === undefined
        ? createMock(origin, \`\${name}()\`)
        : implementation(...args);
    },
    construct(_target, args) {
      calls.push({ name: \`new \${name}\`, args });
      const implementation =
        implementations.get(\`new \${name}\`) ?? fixtures.get(\`new \${name}\`);
      return implementation === undefined
        ? createMock(origin, \`\${name}#\`)
        : implementation(...args);
    },
    has() {
      return true;
    },
  });
}
`;

/** Its declarations, written at the harness's `mock.d.ts`. */
export const MOCK_RUNTIME_TYPES = `export interface RecordedCall {
  readonly name: string;
  readonly args: readonly unknown[];
}
export function recordedCalls(): RecordedCall[];
export function resetMocks(): void;
export function mockImplementation(
  path: string,
  implementation: (...args: unknown[]) => unknown,
): void;
export function fixture(
  path: string,
  implementation: (...args: any[]) => unknown,
): void;
export function createMock(origin: string, name?: string): any;
`;

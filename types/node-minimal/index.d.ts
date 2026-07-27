/** Minimal Node 24 ambient types so we can use node:test without @types/node. */

declare module "node:assert/strict" {
  function equal(actual: unknown, expected: unknown, message?: string | Error): void;
  function deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  function ok(value: unknown, message?: string | Error): void;
  function strictEqual(actual: unknown, expected: unknown, message?: string | Error): void;

  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    strictEqual: typeof strictEqual;
  };

  export { equal, deepEqual, ok, strictEqual };
  export default assert;
}

declare module "node:test" {
  type TestFn = () => void | Promise<void>;

  export function test(name: string, fn: TestFn): void;
  export function test(name: string, options: object, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

/**
 * Load Pi's ESM-only packages from both Next/Vitest and the tsx worker.
 *
 * The repository package itself is CommonJS-shaped for tsx, while Pi exposes
 * an `import` condition without a `require` condition. A normal TypeScript
 * `import()` is rewritten to `require()` in that worker mode, so this tiny
 * boundary deliberately asks Node for its native dynamic import.
 */
export function importNativeEsm<T>(specifier: string): Promise<T> {
  const load = new Function("moduleName", "return import(moduleName)") as (
    moduleName: string,
  ) => Promise<T>;
  return load(specifier);
}

export function isTsxWorker(): boolean {
  return (
    typeof process !== "undefined" &&
    process.argv.some((argument) => argument.includes("/tsx/") || argument.endsWith("/tsx"))
  );
}

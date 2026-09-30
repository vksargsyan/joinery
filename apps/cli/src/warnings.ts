/**
 * Hides Node's "SQLite is an experimental feature" warning (ADR 0002: the local store runs on
 * node:sqlite), which would otherwise print on every command that opens the store. The shebang
 * passes --no-warnings=ExperimentalWarning; this covers `node dist/joinery.mjs` too. Node emits
 * the warning on the next tick after node:sqlite loads, and the store loads it only when it
 * opens (@joinery/storage's sqlite.ts), so installing this at the top of the entry module is
 * early enough. Every other warning still prints.
 */
export function silenceSqliteWarning(): void {
  type Emit = (event: string | symbol, ...args: unknown[]) => boolean;
  const target = process as unknown as { emit: Emit };
  const original = target.emit.bind(process) as Emit;
  target.emit = (event, ...args) => {
    const [warning] = args;
    if (
      event === 'warning' &&
      warning instanceof Error &&
      warning.name === 'ExperimentalWarning' &&
      /SQLite/i.test(warning.message)
    ) {
      return false;
    }
    return original(event, ...args);
  };
}

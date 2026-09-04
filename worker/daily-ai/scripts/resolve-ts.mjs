/**
 * Let Node resolve the worker's extensionless imports (`./pool`, `../tmdb`) the way
 * wrangler's bundler does, so the generators can be RUN as they actually ship.
 *
 * Tooling-only. Production imports stay in the worker's own style rather than being
 * reshaped to suit a script.
 *
 * Usage: node --import ./scripts/resolve-ts.mjs --experimental-strip-types <script>
 *
 * ## `registerHooks`, not `register`
 *
 * `register()` runs the hooks on a separate loader THREAD, and on Windows that thread's
 * teardown races the main process exit -- libuv aborts in src/win/async.c AFTER the work
 * has finished, so a successful run reports as a failure roughly one time in four.
 * `registerHooks()` runs them in-thread: no worker, no async handle, nothing to race.
 * That is the only reason the hooks below are synchronous.
 *
 * Lifted from flickto-web/test/resolve-ts.mjs, which hit both problems first.
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The bundler infers a JSON module from the extension; Node demands an explicit
 * `with { type: "json" }` the worker's own source has no reason to carry. The attribute
 * has to be RETURNED from the hook -- passing it into `nextResolve` is not enough,
 * because it is the load step that validates it.
 */
const asJson = (resolved) => ({
  ...resolved,
  importAttributes: { ...resolved.importAttributes, type: "json" },
});

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.(ts|tsx|mjs|js|json)$/.test(specifier)) {
      const base = new URL(specifier, context.parentURL);
      for (const ext of [".ts", ".tsx", ".json"]) {
        const candidate = new URL(base.href + ext);
        if (existsSync(fileURLToPath(candidate))) {
          const resolved = nextResolve(candidate.href, context);
          return ext === ".json" ? asJson(resolved) : resolved;
        }
      }
    }
    const resolved = nextResolve(specifier, context);
    return /\.json$/.test(resolved.url) ? asJson(resolved) : resolved;
  },
});

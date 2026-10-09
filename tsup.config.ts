import { defineConfig } from "tsup";

/**
 * One runtime dependency, `seatledger`, for its transcript readers, its API price tables and the
 * dated plan table it compares against; it has none of its own. `seatledger` stays external (tsup
 * leaves dependencies out of the bundle), so npx installs two packages and the
 * readers and prices are never copied. Nothing in either opens a network connection on the paths
 * tokens-per-dollar calls.
 */
export default defineConfig({
  entry: { cli: "src/cli.ts", index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  splitting: false,
});

import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["bin/server.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  outDir: "dist",
  root: ".",
  unbundle: true,
  outExtensions: () => ({ js: ".js" }),
  sourcemap: true,
  clean: true,
  report: false,
  deps: {
    neverBundle: true,
  },
  copy: [
    { from: "src/public/*", to: "dist/src/public", flatten: true },
    { from: "assets/default-screenshot.png", to: "dist/assets", flatten: true },
    { from: "package.json", to: "dist", flatten: true },
  ],
});

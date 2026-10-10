#!/usr/bin/env node
/**
 * Build the extension. One cross-browser build serves Chrome and Firefox.
 *
 *   node scripts/build.mjs           # production build
 *   node scripts/build.mjs --watch   # dev build, rebuild on change
 *
 * Output: dist/ (load unpacked from here).
 */
import { cp, mkdir, rm } from "node:fs/promises";
import * as esbuild from "esbuild";

const OUTDIR = "dist";
const dev = process.argv.includes("--watch");

await rm(OUTDIR, { recursive: true, force: true });
await mkdir(OUTDIR, { recursive: true });
await Promise.all([
  cp("public", OUTDIR, { recursive: true }),
  cp("src/popup/popup.html", `${OUTDIR}/popup.html`),
  cp("src/popup/popup.css", `${OUTDIR}/popup.css`),
]);

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: {
    background: "src/background/index.ts",
    content: "src/content/index.ts",
    popup: "src/popup/popup.ts",
  },
  outdir: OUTDIR,
  bundle: true,
  // Content scripts can't be ES modules, and Firefox event pages aren't
  // module workers, so every entry is a self-contained IIFE.
  format: "iife",
  // Keep in sync with the minimum versions in public/manifest.json.
  target: ["chrome121", "firefox128"],
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  legalComments: "none",
  logLevel: "info",
};

if (dev) {
  await (await esbuild.context(options)).watch();
  console.log("Watching for changes… load dist as an unpacked extension.");
} else {
  await esbuild.build(options);
}

import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const watch = process.argv.includes("--watch");

mkdirSync("dist", { recursive: true });

const define = { "process.env.NODE_ENV": '"production"' };

async function buildOnce() {
  // Main thread bundle
  await esbuild.build({
    entryPoints: ["src/code.ts"],
    bundle: true,
    outfile: "dist/code.js",
    format: "iife",
    target: "es2020",
    platform: "browser",
    minify: true,
    define,
    logLevel: "info",
  });

  // UI bundle (JS + CSS), then inline both into a single ui.html
  const result = await esbuild.build({
    entryPoints: ["src/ui/index.tsx"],
    bundle: true,
    write: false,
    outdir: "dist-ui-tmp",
    format: "iife",
    target: "es2020",
    platform: "browser",
    jsx: "automatic",
    minify: true,
    define,
    loader: { ".css": "css" },
    logLevel: "info",
  });

  let js = "";
  let css = "";
  for (const file of result.outputFiles) {
    if (file.path.endsWith(".css")) css += file.text;
    else if (file.path.endsWith(".js")) js += file.text;
  }

  const template = readFileSync("src/ui/ui.html", "utf-8");
  const html = template.replace("__STYLES__", css).replace("__SCRIPT__", js);
  writeFileSync("dist/ui.html", html);
  console.log("dist/ui.html written (" + html.length + " bytes)");
}

if (watch) {
  const ctx = await esbuild.context({
    entryPoints: ["src/code.ts"],
    bundle: true,
    outfile: "dist/code.js",
    format: "iife",
    target: "es2020",
    platform: "browser",
    define,
  });
  await ctx.watch();
  console.log("Watching src/code.ts...");

  setInterval(buildOnce, 1500);
} else {
  await buildOnce();
}

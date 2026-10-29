// Builds web/src into a single self-contained HTML file at ../src/index.html,
// which the Zig server embeds at compile time. Usage: node scripts/build.mjs [--watch]
import { build, context } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");
const srcDir = path.join(webRoot, "src");
// --kit: widget kit (every widget at every size on fixture data) -> web/dist/kit.html
// --demo: the whole interface on fixture data, no station -> web/dist/demo.html
// Both are dev artefacts and are never embedded in the binary.
const mode = process.argv.includes("--kit") ? "kit" : process.argv.includes("--demo") ? "demo" : "app";
const outFile = mode === "app" ? path.resolve(webRoot, "..", "src", "index.html") : path.join(webRoot, "dist", `${mode}.html`);
const watch = process.argv.includes("--watch");

const jsOptions = {
  entryPoints: [path.join(srcDir, mode === "app" ? "main.ts" : `${mode}/main.ts`)],
  bundle: true,
  write: false,
  format: "iife",
  target: ["es2020"],
  minify: true,
  charset: "utf8",
  legalComments: "none",
  logLevel: "silent",
  loader: { ".css": "empty" },
};

const cssOptions = {
  entryPoints: [path.join(srcDir, "styles", "index.css")],
  bundle: true,
  write: false,
  minify: true,
  charset: "utf8",
  logLevel: "silent",
};

function outputText(result) {
  const file = result.outputFiles?.[0];
  if (!file) throw new Error("esbuild produced no output");
  return file.text;
}

function assemble(template, css, js) {
  const safeCss = css.replace(/<\/style/gi, "<\\/style");
  const safeJs = js.replace(/<\/script/gi, "<\\/script");
  return template.replace("/*__CSS__*/", () => safeCss).replace("/*__JS__*/", () => safeJs);
}

async function bundleOnce() {
  const [template, jsResult, cssResult] = await Promise.all([
    readFile(path.join(srcDir, "template.html"), "utf8"),
    build(jsOptions),
    build(cssOptions),
  ]);
  const html = assemble(template, outputText(cssResult), outputText(jsResult));
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, html, "utf8");
  if (mode === "demo") {
    // The demo's image widget shows the project logo next to demo.html.
    await mkdir(path.join(webRoot, "dist", "assets"), { recursive: true });
    await copyFile(path.resolve(webRoot, "..", "docs", "assets", "logo.svg"), path.join(webRoot, "dist", "assets", "logo.svg"));
  }
  const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
  console.log(`panel-web: wrote ${path.relative(process.cwd(), outFile)} (${kb} KiB)`);
}

async function bundleWatch() {
  let timer;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      bundleOnce().catch((error) => console.error("panel-web: build failed\n", error.message ?? error));
    }, 50);
  };
  const plugin = { name: "rebuild-html", setup: (b) => b.onEnd(rebuild) };
  const [jsCtx, cssCtx] = await Promise.all([
    context({ ...jsOptions, plugins: [plugin] }),
    context({ ...cssOptions, plugins: [plugin] }),
  ]);
  await Promise.all([jsCtx.watch(), cssCtx.watch()]);
  console.log("panel-web: watching web/src (template changes require a manual save of any .ts/.css file)");
}

try {
  if (watch) await bundleWatch();
  else await bundleOnce();
} catch (error) {
  console.error("panel-web: build failed\n", error.message ?? error);
  process.exit(1);
}

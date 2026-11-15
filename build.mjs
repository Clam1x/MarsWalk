import { cp, mkdir, rm } from "node:fs/promises";
import { build } from 'esbuild';

await rm("dist", { recursive: true, force: true });
await mkdir("dist/src", { recursive: true });
await Promise.all([
  cp("index.html", "dist/index.html"),
  cp("styles.css", "dist/styles.css"),
  cp("data", "dist/data", { recursive: true })
]);
// Keep original PDS labels in source control for reproducibility, not in the site.
await rm("dist/data/mars-global.lbl", { force: true });
await build({entryPoints:['src/app.js','src/global-route-worker.js'],outdir:'dist/src',bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'warning'});
console.log("Built static site in dist/");

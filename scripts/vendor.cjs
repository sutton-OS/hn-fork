const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "node_modules/dompurify");
const version = JSON.parse(fs.readFileSync(path.join(dist, "package.json"), "utf8")).version;
const files = [
  [path.join(dist, "dist/purify.es.mjs"), path.join(root, `public/vendor/dompurify-${version}.es.mjs`)],
  [path.join(dist, "LICENSE"), path.join(root, "public/vendor/DOMPurify.LICENSE")],
];
for (const [source, target] of files) {
  const expected = fs.readFileSync(source);
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(target) || !expected.equals(fs.readFileSync(target))) {
      throw new Error(`Vendored DOMPurify differs from the locked package. Run npm run vendor:sync (${target}).`);
    }
  } else {
    fs.copyFileSync(source, target);
  }
}
const importPath = `vendor/dompurify-${version}.es.mjs`;
for (const file of ["public/modules/sanitize.js", "public/index.html"]) {
  if (!fs.readFileSync(path.join(root, file), "utf8").includes(importPath)) {
    throw new Error(`Update the DOMPurify reference in ${file} to ${importPath}.`);
  }
}

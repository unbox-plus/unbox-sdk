// Roda todas as checagens de tools/check-*.mjs contra o dist/ — é o `npm test` (que faz o build antes).
// Arquivo novo `check-*.mjs` entra sozinho, sem mexer no package.json. Fica fora do `files`.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const checks = readdirSync(DIR).filter((f) => /^check-.+\.mjs$/.test(f)).sort();
if (!checks.length) { console.error("nenhum tools/check-*.mjs encontrado"); process.exit(1); }

const falhas = [];
for (const f of checks) {
  console.log(`\n▸ ${f}`);
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { stdio: "inherit" });
  if (r.status !== 0) falhas.push(f);
}
if (falhas.length) {
  console.error(`\n✗ ${falhas.length} de ${checks.length} checagens falharam: ${falhas.join(", ")}`);
  process.exit(1);
}
console.log(`\n✓ ${checks.length} checagens passaram`);

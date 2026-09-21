// ═══════════════════════════════════════════════════════════════════════════════════════
// RELEASE NO GITHUB — node tools/github-release.mjs
//
// Lê o primeiro bloco do CHANGELOG.md da branch `main` e publica o release correspondente
// no repositório declarado no `package.json`, criando a tag a partir de `main`.
//
// O mapeamento é o mesmo que vinha sendo feito à mão, e é o que os releases já publicados
// seguem:
//
//     ### v0.20.5 — ajustes no README      →  tag:    0.20.5        (sem o "v")
//                                             título: v0.20.5 — ajustes no README
//     <corpo do bloco, verbatim>           →  descrição do release
//
// ── DE ONDE VEM O TEXTO ────────────────────────────────────────────────────────────────
// Do `origin/main`, não da cópia de trabalho. A tag nasce de `main`, então as notas têm de
// vir do MESMO commit que a tag vai apontar: rodar isto com o working tree sujo, ou de outra
// branch, publicaria um release descrevendo algo que não está em `main`. Com `--local`, lê do
// `main` local (útil sem rede), e aí o aviso sai na prévia.
//
// A tag é criada apontando para o SHA do topo de `main`, e não para o nome "main". É a mesma
// coisa no instante em que se lê, e deixa de ser se alguém empurrar um commit entre a leitura
// do changelog e a criação do release: o nome seguiria o commit novo e a tag ficaria em cima
// de um texto que este script nunca leu.
//
// ── O QUE FAZ O SCRIPT PARAR ───────────────────────────────────────────────────────────
// Publicar release é irreversível na prática (a tag vira referência pública, e quem já
// baixou não desbaixa), então as conferências acontecem ANTES e qualquer uma delas aborta:
//
//   • a versão do bloco não bate com a do `package.json` do mesmo commit. Uma das duas está
//     desatualizada, e adivinhar qual é justamente o que não se deve fazer aqui;
//   • a tag já existe no remoto, ou já existe release com ela;
//   • o título do bloco não está no formato `vX.Y.Z — descrição`.
//
// E a última palavra é de quem roda: a prévia sai completa na tela e o release só é criado
// depois do "sim". `--sim` pula a pergunta (para CI), `--previa` nunca cria nada.
//
//     node tools/github-release.mjs              # prévia + confirmação
//     node tools/github-release.mjs --previa     # só mostra o que faria
//     node tools/github-release.mjs --sim        # sem perguntar
//     node tools/github-release.mjs --rascunho   # cria como draft, para revisar antes
// ═══════════════════════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const OPCOES = {
  previa: args.includes("--previa"),
  sim: args.includes("--sim"),
  rascunho: args.includes("--rascunho"),
  local: args.includes("--local"),
};
const desconhecida = args.find((a) => !Object.keys(OPCOES).some((k) => a === `--${k}`));
if (desconhecida) abortar(`opção desconhecida: ${desconhecida}`, "Use --previa, --sim, --rascunho ou --local.");

function abortar(motivo, ...detalhes) {
  console.error(`\n✗ Release não criado: ${motivo}\n`);
  for (const d of detalhes) console.error(`  ${d}`);
  console.error("");
  process.exit(1);
}

// spawnSync sem shell: título e corpo do changelog têm travessão, crase e aspas, e nada
// disso pode passar por interpretação de shell.
function rodar(cmd, argv, opcoes = {}) {
  const r = spawnSync(cmd, argv, { encoding: "utf8", cwd: RAIZ, ...opcoes });
  if (r.error && r.error.code === "ENOENT") return { ok: false, code: 127, saida: "", erro: `${cmd} não encontrado` };
  return { ok: r.status === 0, code: r.status, saida: (r.stdout ?? "").trim(), erro: (r.stderr ?? "").trim() };
}

// ── Ferramentas ─────────────────────────────────────────────────────────────────────────
if (!rodar("git", ["rev-parse", "--git-dir"]).ok) abortar("isto não é um repositório git.");
if (rodar("gh", ["--version"]).code === 127) {
  abortar("o GitHub CLI (`gh`) não está instalado.", "Instale em https://cli.github.com e rode `gh auth login`.");
}
const auth = rodar("gh", ["auth", "status"]);
if (!auth.ok) abortar("o `gh` não está autenticado.", "Rode `gh auth login` (ou exporte GH_TOKEN) e tente de novo.");

// ── O repositório, do package.json ──────────────────────────────────────────────────────
// Fonte única: o mesmo campo que o npm publica. Aceita as três formas que aparecem por aí
// (`git+https`, `https` e `git@`), porque qualquer uma delas é válida no `repository.url`.
const pkgLocal = JSON.parse(fs.readFileSync(path.join(RAIZ, "package.json"), "utf8"));
const urlRepo = typeof pkgLocal.repository === "string" ? pkgLocal.repository : pkgLocal.repository?.url;
if (!urlRepo) abortar("o `package.json` não declara `repository.url`.");
const casado = urlRepo.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
if (!casado) abortar(`não consegui ler dono/repositório de "${urlRepo}".`, "Esperado algo como https://github.com/dono/repo.git");
const REPO = `${casado[1]}/${casado[2]}`;

// ── A branch main, e o commit que a tag vai apontar ─────────────────────────────────────
let ref = "origin/main";
let avisoRef = null;
if (OPCOES.local) {
  ref = "main";
  avisoRef = "lendo do `main` LOCAL (--local): pode estar atrás do que está no GitHub.";
} else {
  const fetch = rodar("git", ["fetch", "origin", "main", "--quiet"]);
  if (!fetch.ok) {
    ref = "main";
    avisoRef = `não consegui atualizar o origin/main (${fetch.erro.split("\n")[0] || "falha no fetch"}); lendo do \`main\` LOCAL.`;
  }
}
const commit = rodar("git", ["rev-parse", ref]);
if (!commit.ok) abortar(`a ref \`${ref}\` não existe neste repositório.`, "Sem ela não há de onde ler o changelog nem de onde criar a tag.");
const SHA = commit.saida;

function arquivoDaRef(nome) {
  const r = rodar("git", ["show", `${ref}:${nome}`]);
  if (!r.ok) abortar(`não achei \`${nome}\` em \`${ref}\`.`, r.erro.split("\n")[0] ?? "");
  return r.saida;
}

// ── O primeiro bloco do changelog ───────────────────────────────────────────────────────
// Primeiro DEPOIS de "## Changelog": o arquivo abre com esse título, e um bloco antes dele
// seria texto de apresentação, não versão.
function primeiroBloco(texto) {
  const linhas = texto.split("\n");
  const ini = linhas.findIndex((l) => l.trim() === "## Changelog");
  if (ini === -1) abortar("não achei a seção `## Changelog` no CHANGELOG.md.");

  const iTitulo = linhas.findIndex((l, i) => i > ini && /^### .+/.test(l));
  if (iTitulo === -1) abortar("não achei nenhuma entrada `### ...` depois de `## Changelog`.");

  const resto = linhas.slice(iTitulo + 1);
  const fim = resto.findIndex((l) => /^### /.test(l));
  const corpo = (fim === -1 ? resto : resto.slice(0, fim)).join("\n").replace(/^\s*\n+/, "").replace(/\s+$/, "");
  return { titulo: linhas[iTitulo].replace(/^### /, "").trim(), corpo };
}

const bloco = primeiroBloco(arquivoDaRef("CHANGELOG.md"));
const versao = bloco.titulo.match(/^v(\d+\.\d+\.\d+)(?:\s|$)/);
if (!versao) {
  abortar(
    `o título do primeiro bloco não começa com uma versão: "${bloco.titulo}".`,
    'Esperado `### vX.Y.Z — descrição`, como em "### v0.20.5 — ajustes no README".',
  );
}
const TAG = versao[1];
if (!bloco.corpo) abortar(`o bloco \`${bloco.titulo}\` está sem corpo, e o release ficaria sem descrição.`);

// A versão do bloco tem de ser a do package.json DO MESMO COMMIT. Se divergirem, uma das
// duas ficou para trás, e publicar seria carimbar a divergência numa tag.
const versaoPkg = JSON.parse(arquivoDaRef("package.json")).version;
if (versaoPkg !== TAG) {
  abortar(
    `o changelog diz ${TAG} e o package.json de \`${ref}\` diz ${versaoPkg}.`,
    "Acerte as duas em `main` antes de publicar: a tag e o pacote não podem contar versões diferentes.",
  );
}

// ── A tag e o release não podem já existir ──────────────────────────────────────────────
const noRemoto = rodar("git", ["ls-remote", "--tags", "origin", `refs/tags/${TAG}`]);
if (noRemoto.ok && noRemoto.saida) {
  abortar(`a tag ${TAG} já existe no remoto.`, "Ou a versão já foi publicada, ou falta bumpar a versão em `main`.");
}
if (rodar("gh", ["release", "view", TAG, "--repo", REPO]).ok) {
  abortar(`já existe um release ${TAG} em ${REPO}.`, `Veja em https://github.com/${REPO}/releases/tag/${TAG}`);
}
// Tag local sem par no remoto não impede nada (o release é criado pelo GitHub), mas avisa:
// costuma ser sinal de que a versão anterior foi tagueada à mão e não empurrada.
const tagLocal = rodar("git", ["rev-parse", "--verify", `refs/tags/${TAG}`]).ok;

// ── Prévia ──────────────────────────────────────────────────────────────────────────────
const linhasCorpo = bloco.corpo.split("\n");
const amostra = linhasCorpo.slice(0, 12);

console.log(`
┌─ Release a criar ${"─".repeat(60)}
│  repositório: ${REPO}
│  tag:         ${TAG}          (a partir de ${ref} @ ${SHA.slice(0, 8)})
│  título:      ${bloco.titulo}
│  descrição:   ${linhasCorpo.length} linha(s)${OPCOES.rascunho ? "\n│  rascunho:    sim (draft, não fica visível até publicar)" : ""}
└${"─".repeat(78)}
`);
for (const l of amostra) console.log(`  ${l}`);
if (linhasCorpo.length > amostra.length) console.log(`  … (+${linhasCorpo.length - amostra.length} linhas)`);
console.log("");
if (avisoRef) console.log(`  ! ${avisoRef}`);
if (tagLocal) console.log(`  ! existe uma tag ${TAG} local que não está no remoto; o release usará o commit ${SHA.slice(0, 8)}.`);

if (OPCOES.previa) {
  console.log("\n  Prévia apenas (--previa). Nada foi criado.\n");
  process.exit(0);
}

// ── Confirmação ─────────────────────────────────────────────────────────────────────────
if (!OPCOES.sim) {
  if (!process.stdin.isTTY) {
    abortar("sem terminal para confirmar.", "Rode com `--sim` para publicar sem perguntar, ou `--previa` para só conferir.");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const resposta = (await rl.question(`\n  Criar este release em ${REPO}? [s/N] `)).trim().toLowerCase();
  rl.close();
  if (resposta !== "s" && resposta !== "sim") {
    console.log("\n  Cancelado. Nada foi criado.\n");
    process.exit(0);
  }
}

// ── Criação ─────────────────────────────────────────────────────────────────────────────
// O corpo vai por stdin (`--notes-file -`): changelog tem crase, aspas e travessão, e um
// arquivo temporário só acrescentaria lixo para limpar depois.
const argv = ["release", "create", TAG, "--repo", REPO, "--target", SHA, "--title", bloco.titulo, "--notes-file", "-"];
if (OPCOES.rascunho) argv.push("--draft");

const criado = rodar("gh", argv, { input: bloco.corpo });
if (!criado.ok) {
  abortar(`o \`gh\` falhou ao criar o release (código ${criado.code}).`, ...(criado.erro || criado.saida).split("\n"));
}

const url = criado.saida.split("\n").find((l) => l.startsWith("http")) ?? `https://github.com/${REPO}/releases/tag/${TAG}`;
console.log(`\n✓ Release ${bloco.titulo} criado${OPCOES.rascunho ? " como rascunho" : ""}, com a tag ${TAG} em ${SHA.slice(0, 8)}.`);
console.log(`  ${url}\n`);

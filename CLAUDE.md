# unbox-sdk: o que todo agente precisa saber antes de mexer

Repositório do `@unbox-plus/sdk`. O `README.md` é público (vai ao npm e ao GitHub) e é documento de quem USA o
pacote; o que é de quem mantém fica aqui. Este arquivo não vai para o npm (o `files` do `package.json` é lista
fechada).

## Quem consome o SDK, e por que a ordem importa

A CLI (`@unbox-plus/cli`, repositório `unbox-cli`) depende do SDK duas vezes: no `package.json` dela e no
`template/package.json`, que é copiado para cada loja. Abaixo de 1.0, `^0.4.1` não aceita `0.5.0`: versão minor
nova só chega à CLI e às lojas com bump explícito lá. Por isso:

- o SDK é publicado ANTES; a mudança na CLI que usa um método novo só entra depois que a versão está no npm;
- método ou campo novo sobe o **minor**; correção sobe o **patch** (é o critério do histórico: 0.4.0 trouxe
  métodos de kit, 0.4.1 corrigiu o payload do `updateItems`);
- toda entrada do CHANGELOG abre dizendo se algo quebrou ("**Nada quebrou.** ... atualizar é só o
  `npm install`"), porque é o que quem atualiza a CLI precisa saber primeiro.

## Durante o desenvolvimento (até o release ser pedido)

- **Não mexer na versão do `package.json`/`package-lock.json`.** O bump é o primeiro passo do release, e só
  acontece quando o usuário pede o release.
- **O CHANGELOG ganha uma seção `### próxima versão`** logo abaixo de `## Changelog`, no topo (mesmo nível
  das versões publicadas). Toda mudança que entra em `develop` escreve ali o seu texto, no mesmo estilo dos
  blocos publicados; se a seção já existe, acrescente nela (nunca uma segunda). O `tools/github-release.mjs` recusa publicar enquanto ela existir.
- `npm test` verde: faz o build e roda todas as checagens `tools/check-*.mjs` contra o `dist/`
  (`tools/run-checks.mjs`). Não há suíte de testes; checagem nova é um `tools/check-<assunto>.mjs` que sai
  com código ≠ 0 se falhar, e entra no `npm test` sozinha.
- Fluxo de branches: `feat/ubx-NNNN` ou `fix/ubx-NNNN` a partir de `develop` → PR para `develop` → `develop`
  entra em `main` para publicar.

## Ao fechar uma versão (só quando o usuário pedir o release)

1. bump da versão em `package.json` e no lock: `npm version X.Y.Z --no-git-tag-version`;
2. trocar o título `### próxima versão` por `### vX.Y.Z — descrição curta` (é o título do release no GitHub; o
   `github-release.mjs` recusa título fora desse formato ou versão diferente da do `package.json`);
3. `npm test` verde (roda também no `prepack`, e por isso no `npm publish` do workflow: sem ele não há pacote);
4. com tudo em `main` e a árvore limpa, `npm run release`: lê o bloco do CHANGELOG em `origin/main`, confere a
   versão, cria a tag (sem o "v") no SHA de `main` e o release no GitHub. O workflow
   `.github/workflows/npm-publish.yml` publica no npm, com provenance, quando o release sai.
   `npm run release -- --previa` só mostra o que faria.
5. **Nunca `npm publish` à mão.** A publicação é a do workflow, a partir do release.

Depois de publicado, a CLI pode subir o `^` dela (ver "Mexer na CLI contra um SDK que ainda não foi publicado"
no `LEIA-ME-FONTE.md` do `unbox-cli` para testar antes disso por `file:`).

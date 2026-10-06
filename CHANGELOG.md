## Changelog

### v0.2.0 — o vocabulário interno do pacote fica em inglês

**Nada mudou na API nem no comportamento.** Mesmos exports, mesmas assinaturas, mesmas consultas
ao gateway: atualizar de 0.1.0 para 0.2.0 é só o `npm install`, sem tocar em arquivo nenhum da
loja. O que mudou está inteiro abaixo da fronteira do pacote, e a razão é que o código nasceu
com vocabulário misturado — identificadores em português colados num schema GraphQL em inglês —
e cada leitura cobrava uma tradução no meio do caminho.

- **`src/pedido.ts` virou `src/order.ts`.** É módulo interno: o `exports` do pacote publica só
  `.` e `./webhooks`, então `withLeanSelection`, `normalizeThumbnails`, `isSessionError`,
  `ITEM_IMAGES`, `DETAILED_SUMMARY` e `SHIPPING_AND_TRACKING` continuam chegando pelo índice,
  no mesmo lugar de sempre.
- **Os nomes de módulo e os auxiliares privados foram traduzidos.**
  `ehUniaoNaoResolvida` → `isUnionNotResolved`, `semOcultos` → `onlyVisibles`,
  `esquemaAceito` → `acceptedScheme`, `ERROS_OAUTH` → `OAUTH_ERRORS`, mais as variáveis locais
  da montagem da consulta de pedido (`selecao`/`rica`/`endereco` → `selection`/`rich`/`address`).
  Nenhum deles é exportado, e nenhum aparece em mensagem de erro que a loja leia.
- **`connectUnboxStore(credentials)`:** o parâmetro trocou de nome, e isso aparece na dica do
  editor e na documentação. A chamada é posicional, então não há nada a mudar na loja. O
  docblock passou a dizer "conecta à loja", que é o que a função faz desde que deixou de se
  chamar `createUnboxStore`.
- **Comentário e texto de tela seguem em PT-BR.** As peculiaridades do gateway escritas ao lado
  de cada chamada, a tradução de erro e os rótulos de status têm leitor humano — quem mantém a
  loja e quem está comprando. Só o vocabulário do código mudou de idioma.

### v0.1.0 — a integração com a Unbox sai do template e vira pacote

Primeira versão. O conteúdo vem de `lib/unbox/*.ts` do template do
[`@unbox-plus/cli`](https://github.com/unbox-plus/unbox-cli) v0.24.0, que era **copiado** para
cada loja gerada: toda correção na integração exigia substituir arquivo a arquivo em cada loja no
ar, uma por uma, e antes disso descobrir quais lojas estavam atrás. Agora é
`npm install @unbox-plus/sdk@latest`, sem tocar em arquivo nenhum da loja.

**As chamadas chegaram sem mudança de comportamento.** `UnboxClient`, `UnboxCustomerClient`, as
seleções de pedido com volta para a enxuta, a tradução de erro em PT-BR, os rótulos de status e a
verificação de webhook são os mesmos, com as mesmas peculiaridades do gateway escritas ao lado de
cada chamada. Migração de uma loja existente: passo a passo no README.

O que mudou de forma na fronteira do pacote:

- **`connectUnboxStore(credenciais)` substitui o `lib/unbox/store.ts` da loja.** O cache de token
  (um signIn, renovação com 1h de folga, dedup das chamadas concorrentes, re-signin uma vez em
  token vencido) virou uma instância em vez de estado de módulo, e as credenciais entram
  explícitas, como objeto ou como função. **O pacote não lê `process.env` por conta própria** —
  fora de `credentialsFromEnv()`, que é explícito: quem monta a loja decide de onde vêm as
  credenciais, e é isso que permite testar o SDK sem ambiente.
- **`tokenStore` é novo, e é o ponto de extensão para serverless.** Sem ele, o cache é por lambda
  (um signIn por lambda fria); com um KV, é um por loja.
- **`getCustomerClient(token)` absorveu a regra de sessão vencida.** Token ausente ou expirado
  devolve `null`, que é o mesmo que deslogado. Ficava na loja, em `lib/customer-session.ts`, e
  sem essa conta a loja se achava logada, toda consulta quebrava com erro opaco do backend e a
  conta virava beco sem saída.
- **`loadAllCatalogItems` entrou.** É a paginação por offset do catálogo inteiro (sitemap,
  llms.txt), com o teto de segurança: `first` gigante trunca em silêncio no servidor, e a página
  some do sitemap sem erro nenhum.
- **`invalidAddressMessage` entrou.** Lê `invalidAddressFields` do erro da Unbox e diz qual
  campo do formulário corrigir. Era um helper privado do BFF da loja; é interpretação de erro da
  API, então mora com o resto.
- **A leitura do JWT não usa mais `Buffer`.** `decodeJwtClaims`, `isJwtExpired` e
  `shopClaimsFromToken` rodam no Edge Runtime, onde `Buffer` não existe.
- **`node:crypto` mudou de endereço: `@unbox-plus/sdk/webhooks`.** O índice principal ficou
  livre de builtin do Node porque a loja importa a tradução de erro em componente de cliente, e
  um `node:crypto` no bundle do navegador derruba o build. Medido no template: com o índice
  limpo, o bundle do cliente leva só o rótulo importado, e nenhuma query do GraphQL.
- **Sem dependências de runtime, e nenhum import de framework.** Nada aqui conhece `next`,
  `react` ou `server-only`: cache de página, shaping para a tela, cookies, rate-limit e
  verificação de posse do pedido continuam sendo decisão da loja.

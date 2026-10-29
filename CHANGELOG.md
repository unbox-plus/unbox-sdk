## Changelog

### v0.4.0 — os dados de kit chegam ao SDK

**Nada quebrou.** Os exports e as assinaturas de 0.3.0 continuam no lugar: atualizar é só o
`npm install`. Tudo o que entrou é aditivo — métodos novos, campos novos nas seleções e tipos
novos. O `getCatalog` continua com a mesma carga de antes.

- **`getProductKit(productId)` entrou.** Devolve o kit com a cota (`requiredPicksPerGroup`), a
  descrição do grupo e os sabores possíveis (`kitComponents`). Id inexistente devolve `null`, não
  lança.
- **`getProductsByIds` passou a trazer `productType`, `requiredPicksPerGroup`,
  `kitGroupDescription` e `relatedInfo`.** Em produto que não é kit os campos vêm vazios.
  `getSubscribableCatalog` não mudou: ele pagina o `getCatalog`, que segue sem esses campos.
- **O item da assinatura traz `productKitId` e `productKitItemsConfigurations`.** Entraram na
  seleção de `subscription()`, `pause`, `skipNextCycle`, `cancel`, `updateItems` e `updateCard`;
  valem `null` em item que não é kit.
- **`updateItems` aceita os dois campos de kit por item.** Quem não os passa envia exatamente o
  mesmo payload de antes.
- **Tipos novos:** `ProductKit`, `ProductKitComponent`, `ProductKitComponentConfiguration`,
  `ProductKitRelatedInfo`, `ProductKitItemInput` e `RecurringOrderItem`; `CatalogProduct` ganha
  `requiredPicksPerGroup`, `kitGroupDescription` e `relatedInfo`, opcionais.
- **`getProductBySlug` traz o que a PDP de kit precisa:** `erpCode`, `requiredPicksPerGroup`,
  `kitGroupDescription`, `relatedInfo` e o `group` com os `linkedProducts` (as outras opções do
  bundle, cada uma com `slug`, `label`, preço e cota). Em produto que não é kit, `group` e os campos
  de kit vêm vazios.
- **E o que a PDP precisa para mostrar cada opção do bundle.** `getProductBySlug` também devolve, no
  produto e em cada `linkedProducts[].catalog`: `pricing[].minCompareAtPrice` (o preço "de",
  riscado), `pricingPerUnit` com `unitPriceLabel` ("R$ 14,00 / dose") e, nas opções,
  `kitGroupDescription` (a descrição de cada uma: sem ela todas herdavam a do grupo). O `kitOptions`
  repassa tudo isso, inclusive para o kit atual, e **deixa de fora a opção oculta no painel** (ela segue
  vinculada ao grupo, mas a página dela dá 404). Em produto que não é kit os campos novos vêm `null`.
  O `getCatalog` segue sem eles.
- **O carrinho aceita kit.** `CartItemInput` virou `CartProductItemInput | CartKitItemInput`; o kit
  entra como `{ kit: { productKitId, picks }, price, quantity }` e vai à API **sem**
  `productConfiguration`. O `price` é o do kit, não a soma dos sabores. `createCart`,
  `addCartItems`, `getCart` e `selectShipping` passam a devolver `kitItemConfigurations` em cada item
  (`null` fora de kit).
- **O `placeOrder` não perde o kit.** `buildOrderItems` devolve o item de kit como
  `productKitConfiguration`, sem `productConfiguration` (que vem `null` no kit). Esse caminho não foi
  exercitado com um pedido real: confira num pedido de teste antes de ir ao ar.
- **O pedido mostra os sabores.** `getOrder` e `order()` do cliente trazem `kitItemConfigurations` nos
  itens, na seleção completa (a enxuta, de reserva, continua sem ele).
- **Kit novo em `kit.ts`:** `groupKitsByTitle` (bundle = kits de mesmo título),
  `kitOptions(product)` (vinculados mais o kit atual, do mais barato ao mais caro),
  `fetchKitTemplate(publishedUrl)` (lê `kitDisplay` e `relatedKits` do template publicado; qualquer
  falha devolve `null`) e `kitPicksProblem(picks, cota)` (mensagem em português para a escolha
  incompleta ou passada da cota).
- **Cota errada na API volta como `MISSING_ITEMS_ERROR`**, que o `friendlyError` traduz como "produtos
  não estão mais disponíveis". Valide antes com `kitPicksProblem`.
- **Tipos novos:** `LinkedProduct`, `ProductKitGroup`, `KitDisplaySettings`, `RelatedKitsSettings`,
  `KitTemplateSettings`, `CartProductItemInput` e `CartKitItemInput`; `PlaceOrderParams.items` aceita
  `productKitConfiguration` e `productConfiguration` nulo. Constante nova: `KIT_ITEM`.

### v0.4.0 — erro com código, formato de auth fixo e renovação na mensagem do gateway

**Duas mudanças de comportamento**, as duas no caminho de erro, e o resto é aditivo. A loja
atualiza com o `npm install`, sem tocar em arquivo, mas vale ler os dois primeiros itens: um
`gql()` que antes devolvia `undefined` agora lança, e uma recusa que antes não renovava o token
agora renova. Quem motivou a versão é a CLI (`unbox`), que fala com a mesma API de parceiros de
um terminal, com saída para agentes, e precisa de erro com código e de um formato de
`Authorization` só.

- **HTTP de erro sem `errors[]` agora lança `UnboxError`, no `gql()` e no `signIn()`.** Um 403
  `{"message":"Forbidden"}` (api key errada) fazia o `gql()` devolver `json.data`, que é
  `undefined`, e o erro aparecia longe dali, como "cannot read property of undefined". No
  `signIn()`, HTML de 502 lançava `SyntaxError` e 4xx sem `errors[]` virava "signIn sem
  access*token". Agora os dois lançam `UnboxError` com `code` `HTTP*<status>`e`message`
`HTTP <status>: <início do corpo>`; o do `signIn`mantém o prefixo`signIn: `, e o timeout do
`signIn`sai como`UNBOX_TIMEOUT`, igual ao `gql()`. O `errors[0].message`fica só`HTTP <status>`, **sem o corpo**: é ele que o `withStoreClient`lê para decidir se renova e
repete a chamada, e um HTML de 504 com "token" no texto, chegando depois de o pedido ter sido
criado, repetiria o`placeOrder`. Um 401 sem `errors[]` passa a renovar o token uma vez, como
  já acontecia quando o corpo não era JSON.
- **`withStoreClient` renova em `Unauthorized - No authenticated user`.** É a forma que o gateway
  de parceiros usa para token vencido, e ela não casava a regra de renovação: o token vencido
  derrubava a chamada em vez de renovar. O termo foi **acrescentado**; nenhum dos antigos saiu.
- **`UnboxError.code` entrou.** `errors[0].extensions.code`, senão `errors[0].errorType`;
  `"TIMEOUT"` no timeout; `HTTP_<status>` no erro de transporte; `undefined` sem nenhum deles. Quem
  mapeia mensagem por código deixa de comparar texto.
- **`isMissingPermissionError(err)` entrou.** Separa "a conta não tem permissão para esta
  operação" (`Unauthorized - Missing required permissions`) de sessão vencida, que se resolve
  renovando. O `isSessionError` casa as duas e continua igual; a diferença está no README.
- **`authScheme: "raw" | "bearer"` entrou**, em `UnboxConfig` e em `UnboxCredentials`. Sem ele,
  nada muda: o client mede o formato do `Authorization`, faz a consulta leve antes da primeira
  mutação e memoriza o formato para o processo. Com ele, o header sai sempre naquele formato, sem
  consulta extra, sem repetição e sem ler nem gravar o formato memorizado. Uma conta só de deploy
  pode não ter acesso ao `shopBySlug` da consulta leve, e o `Bearer` memorizado contrariava a doc
  oficial, que manda token puro.
- **`tools/check-errors.mjs` entrou** (fora do pacote publicado). O pacote não tem suíte de
  testes, e isto cobre o caminho de auth e de erro contra o `dist/` com um `fetch` falso que
  registra os cabeçalhos de cada chamada.

### v0.3.0 — o catálogo passa a responder sobre assinatura

**Nada quebrou.** Os exports de 0.2.0 continuam no lugar, com as mesmas assinaturas: atualizar é
só o `npm install`. O que entrou são dois métodos novos de catálogo e os campos de preço de
assinatura nos tipos — tudo aditivo. A única mudança de comportamento está no `getShop`, e é uma
consulta que **deixou** de quebrar.

- **`getProductsByIds(ids)` entrou.** Vários produtos por id numa chamada só, com a mesma seleção
  do `getProductById` mais o que a tela de edição de assinatura precisa: preço avulso e de
  assinatura, estoque e variantes. Deduplica os ids, devolve `[]` para lista vazia e **não garante
  a ordem** — case o resultado por `productId`/`_id`, porque id desconhecido simplesmente não
  volta e alinhar por índice desalinha a tela inteira.
- **`getSubscribableCatalog()` entrou.** Catálogo inteiro filtrado por `recurrenceAllowed === true`,
  cada produto já com `categories` — as tags resolvidas por nome, e não o `tagIds` cru que obrigava
  quem chama a fazer o cruzamento. Pagina o `getCatalog` de 100 em 100 em paralelo com o `getTags`,
  e tem o freio: **página sem produto novo encerra o laço**. A API ignora o `offset` em algumas
  lojas e devolve `hasNextPage: true` para sempre; sem o freio, é laço infinito repetindo a mesma
  página.
- **`getShop` não derruba mais a consulta em loja com política de assinatura real.**
  `recurringOrdersPolicy.keepOrderPricingPolicy` saiu da seleção: é non-null no schema, mas a API
  manda `null`, e aí o GraphQL mata a resposta inteira com "Cannot return null for non-nullable
  field" — não só o campo. Quem lia esse campo perde ele; quem chamava `getShop` numa dessas lojas
  ganha a resposta de volta.
- **`pricingOnRecurrence` nos tipos, em produto e em variante.** Junto com `isSoldOut` na variante.
  São campos opcionais em `CatalogProduct` e `ProductVariant`, e só vêm preenchidos nas consultas
  que os pedem — `getCatalog` continua com a mesma carga de antes.
- **`SubscribableProduct` é novo.** É `CatalogProduct` mais `categories`, e sai pelo índice como o
  resto dos tipos.

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

# @unbox-plus/sdk

A camada de comunicação com a **API de parceiros da Unbox** (`partners.unbox.com.br/graphql`),
em um pacote só: catálogo, carrinho, checkout, `placeOrder`, pedido, área do cliente,
assinaturas, cupons, CEP, OTP, inventário, payment links e webhooks.

Sem dependências de runtime. Sem `next`, sem `react`: o pacote fala com a Unbox, e quem decide o
que é rota, o que é cache e o que é componente é a loja.

## Por que ele existe

Até a v0.22 do [`@unbox-plus/cli`](https://github.com/unbox-plus/unbox-cli) esse código vivia
dentro do template, em `lib/unbox/*.ts`, e era **copiado** para cada loja gerada. Consequência:
toda correção na integração, inclusive as de segurança e as de cobrança, exigia substituir
arquivo a arquivo em cada loja no ar, uma por uma, e descobrir quais lojas estavam atrás.

Com o SDK à parte, atualizar a integração é:

```bash
npm install @unbox-plus/sdk@latest
```

Nenhum arquivo da loja muda.

## Instalação

```bash
npm install @unbox-plus/sdk
```

Node >= 20.11 (usa `fetch` nativo). Funciona em Node, no runtime serverless da Vercel e no Edge
Runtime; a verificação de webhook (`node:crypto`) é a única parte que exige Node.

## Uso

```ts
import { createUnboxStore } from "@unbox-plus/sdk";

// Uma instância por processo: um signIn, o token da loja em cache, re-signin quando vence.
export const unbox = createUnboxStore(() => ({
  partnerApiKey: process.env.UNBOX_PARTNER_API_KEY!, // do PARCEIRO, vale para todas as lojas dele
  user: process.env.UNBOX_USER!,                     // QUAL loja é o user/senha que diz
  pass: process.env.UNBOX_PASS!,
}));

// A vitrine
const catalogo = await unbox.withStoreClient((c) => c.getCatalog({ first: 24 }));
const produto = await unbox.withStoreClient((c) => c.getProductBySlug("camiseta-preta"));

// O carrinho
const { cartId, cartToken } = await unbox.withStoreClient((c) =>
  c.createCart([{ productId, productVariantId, price, quantity: 1 }]),
);
```

As credenciais podem entrar como objeto ou como **função**. Como função, são lidas no primeiro
uso e não no import — é o que permite um `next build` sem ambiente configurado.

`credentialsFromEnv()` monta o objeto a partir das variáveis padrão (`UNBOX_PARTNER_API_KEY`,
`UNBOX_USER`, `UNBOX_PASS`, `UNBOX_SHOP_ID`, `UNBOX_SHOP_SLUG`,
`UNBOX_PARTNER_GRAPHQL_URL`), e `hasUnboxCredentials(creds)` diz se as três obrigatórias estão
lá — é a régua do "modo mockup" (loja de pé, sem nenhuma chamada à Unbox).

### ⚠️ Server-only

A api key do **parceiro** e o token da **loja** passam por aqui. A api key vale para todas as
lojas do parceiro, e o token de loja lê **qualquer** pedido dela só pelo `referenceId`.
Instanciar `UnboxClient` no navegador entrega as duas ao visitante.

O que pode ir ao navegador com segurança é texto: `friendlyError`, `cartEventLabel` e os rótulos
de status. Eles estão no mesmo índice, e a árvore de exports é lateral-efeito-zero
(`sideEffects: false`), então um bundler moderno leva só o rótulo que você importou.

### Os três cabeçalhos

Toda chamada passa por um endpoint só, e é o cabeçalho que diz quem é quem:

| Cabeçalho | O que leva | Quando |
|---|---|---|
| `x-api-key` | a api key do **parceiro** | sempre |
| `Authorization` | o token da **loja** (o do `signIn`) | sempre, depois do signIn |
| `x-customer-token` | o token do **cliente final** | só na área do cliente |

É de `Authorization` que o gateway extrai o `shopId`, e é por isso que **nenhuma operação manda
shopId**. As duas exceções são campos que o próprio schema declara: o `shopId` de cada
`fulfillmentGroup` no `placeOrder` e o de `CreateCartByTemplateInput`.

## O que tem dentro

### `createUnboxStore(credenciais, { tokenStore? })`

| Método | Para |
|---|---|
| `withStoreClient(fn)` | roda `fn` com o client de loja e repete **uma vez**, com token novo, se o token tinha vencido |
| `getStoreClient()` | o client cru, já autenticado |
| `getShopContext()` | `{ shopId, shopSlug }` resolvidos (credencial explícita ganha; senão sai do claim do token) |
| `getCustomerClient(token)` | client da área do cliente; `null` se o token estiver ausente ou vencido |
| `loadAllCatalogItems(opts?)` | o catálogo inteiro, paginado por offset (sitemap, llms.txt) |
| `hasCredentials` | as três credenciais estão preenchidas? |
| `invalidateToken()` | descarta o token em cache |

**Não faça `signIn` por request.** O token da loja vale ~24h e o signIn é a chamada mais lenta da
API; o cache renova com 1h de folga e deduplica as chamadas concorrentes (dez páginas pedindo
token no mesmo instante fazem um signIn, não dez).

Em serverless o cache é por lambda: um signIn por lambda fria. Para compartilhar entre elas,
passe um `tokenStore` (Vercel KV, Edge Config, Redis) — é o único ponto que muda:

```ts
createUnboxStore(credenciais, {
  tokenStore: {
    read: () => kv.get("unbox:token"),
    write: (t) => kv.set("unbox:token", t),
  },
});
```

### `UnboxClient` — operações de loja

- **Catálogo**: `getCatalog`, `getProductBySlug`, `getProductById`, `getTags`, `getSimpleInventory`
- **Loja**: `getShop`, `getPaymentMethods`, `listDiscountCodes`, `findDiscountIdByCode`
- **Carrinho**: `createCart`, `addCartItems`, `updateItemQuantity`, `removeCartItems`, `getCart`,
  `setEmailOnCart`, `applyDiscount`, `removeDiscount`, `createCartByTemplate`
- **Entrega**: `setShippingAddress`, `getFulfillmentGroupIds`, `quoteShipping`, `selectShipping`,
  `quoteShippingForProduct`, `getAddressByPostalCode`
- **Checkout**: `getInstallments`, `buildOrderItems`, `placeOrder`, `getOrder`
- **Conta (pré-login)**: `requestCustomerOtp`, `customerSignIn`, `customerAccountExists`
- **Payment links**: `createPaymentLink`, `getPublicPaymentLink`
- **Webhooks**: `subscribeWebhook`
- **Cru**: `gql(query, variables, opts)` para o que não tem método

### `UnboxCustomerClient` — a área do cliente

Duas identidades na mesma requisição: a loja no `Authorization`, o cliente no
`x-customer-token`. Por isso ele carrega um `UnboxClient` de loja já autenticado — sem o token da
loja não há contexto de loja, sem o do cliente não há conta.

`me`, `updateAccount`, `orders`, `order`, `subscriptions`, `subscription`, `subscriptionCycles`,
`pause`, `skipNextCycle`, `cancel`, `updateItems`, `updateCard`, `updateAddress`,
`addressBooks`, `upsertAddress`, `deleteAddresses`, `purchasedProducts`.

### Feedback ao cliente final (PT-BR)

- `friendlyError(err)` — o código do erro (`DISCOUNT_EXPIRED_ERROR`, o corpo OAuth do login por
  código) vira frase que a pessoa entende.
- `invalidAddressMessage(err)` — a Unbox diz QUAL campo do endereço recusou
  (`invalidAddressFields`); isto traduz o nome técnico para o nome do campo no formulário.
- `cartEventLabel(type)` — os `cartEvents` (brinde ganho, cupom removido).
- `orderStatusLabel`, `paymentStatusLabel`, `paymentSeal`, `fulfillmentStatusLabel`,
  `fulfillmentTypeLabel`, `trackingStatusLabel`, `subscriptionStatusLabel` — status cru
  (`"SHIPPING · new"`) não é texto para cliente. Cada um devolve o valor original quando ainda
  não conhece o status: novidade da API aparece crua, mas aparece.

### Webhooks

```ts
import { parseUnboxWebhook } from "@unbox-plus/sdk/webhooks";

const evt = await parseUnboxWebhook(req, process.env.UNBOX_WEBHOOK_SECRET!.split(","));
if (evt.type === "PING") return new Response("ok");
```

Subpath próprio porque usa `node:crypto`: um builtin do Node no bundle do navegador derruba o
build, e a tradução de erro (que a loja usa no cliente) está no índice principal.

`verifyUnboxWebhook(rawBody, signature, secret)` aceita **lista** de secrets — cada assinatura de
webhook tem o seu, e uma loja com `ORDER_CREATED` e `ORDER_STATUS_UPDATE` tem dois. Passe o corpo
**cru**: re-serializar o JSON antes muda a assinatura.

### JWT da loja

`decodeJwtClaims`, `isJwtExpired`, `shopClaimsFromToken`, `SHOP_ID_CLAIM`, `SHOP_SLUG_CLAIM`.
Leem, não validam — quem valida é o gateway, a cada chamada. Sem `Buffer`, para rodarem também
no Edge Runtime.

## O que o SDK não faz

De propósito, porque é decisão da loja e não da API:

- **cache de página/dados** (`unstable_cache`, ISR, tags de revalidação);
- **shaping para a tela** (formatar dinheiro, montar a linha do tempo do rastreio);
- **cookies e sessão** (o cookie httpOnly do cliente, o cookie assinado de posse do pedido);
- **rate-limit e locks** do BFF;
- **verificação de posse do pedido** — `getOrder(referenceId)` com token de loja devolve
  **qualquer** pedido. Quem checa posse é a loja, antes de chamar.

## Peculiaridades do gateway, medidas ao vivo

Estão escritas no código, ao lado de cada chamada. As que mais custaram:

- **Argumento opcional não aceita `null`.** A query é montada só com os args presentes.
- **Union exige `__typename`** na seleção, ou o servidor não resolve o tipo.
- **Uma seleção a mais derruba a resposta INTEIRA**, não o campo (`displayStatus`,
  `totalItemQuantity`, `payments.amount.amount`). Por isso as consultas de pedido tentam a
  seleção rica e caem para a enxuta (`withLeanSelection`): perder o histórico de rastreio é
  aceitável, o cliente não ver o pedido que pagou não é.
- **`summary` só volta quando a consulta pede `payments`** (o resolver lê `payments[0].summary`).
  Pedir o total sem pedir o pagamento é GraphQL válido que devolve a lista vazia.
- **`payments.data` é `AWSJSON` assimétrico**: na entrada espera a string já serializada, na
  saída devolve objeto.
- **`placeOrder` tem prazo próprio (90s) e erro próprio (`UNBOX_TIMEOUT`).** Abortar no cliente
  não aborta no servidor: o pedido pode nascer depois que a loja desistiu. Nunca trate timeout de
  `placeOrder` como "tente de novo" — é a cobrança dupla.
- **Mutação nunca repete por erro de auth.** "not authorized" também é o que a adquirente
  responde num cartão recusado.
- **Produto oculto no painel não entra em vitrine.** `catalogItems` não filtra visibilidade; o
  filtro está no ponto por onde todo catálogo passa, e desconta o `totalCount`.
- **O preço final vem sempre do catálogo.** O servidor sobrescreve o preço enviado, e
  `incorrectPriceFailures` vem vazio na prática.
- **`catalogItemProductById` não existe** na API de parceiros; o equivalente é
  `catalogItems(productIdsOrERPCodes: [id], first: 1)`.

## Migrar uma loja que tem `lib/unbox/` internalizado

Lojas geradas pelo CLI até a v0.24 têm a cópia dentro de `lib/unbox/`. Para passar ao pacote:

1. `npm install @unbox-plus/sdk`
2. Apague `lib/unbox/client.ts`, `customer.ts`, `types.ts`, `errors.ts`, `pedido.ts`,
   `webhooks.ts` e `index.ts`.
3. Troque `lib/unbox/store.ts` por um `lib/unbox.ts` que só amarra o ambiente ao pacote
   (o template do CLI tem o arquivo pronto, com `import "server-only"` na primeira linha).
4. Reaponte os imports: `@/lib/unbox/{client,types,errors,customer}` → `@unbox-plus/sdk`,
   `@/lib/unbox/webhooks` → `@unbox-plus/sdk/webhooks`, `@/lib/unbox/store` → `@/lib/unbox`.
5. `lib/config.ts`: `hasUnboxCredentials`, `decodeJwtClaims` e os dois `SHOP_*_CLAIM` saem de lá
   e passam a vir do pacote.
6. `npm run typecheck && npm run build`.

## Desenvolvimento

```bash
npm install
npm run build       # tsc → dist/ (ESM + .d.ts)
npm run typecheck
```

Para testar contra uma loja antes de publicar, aponte o `package.json` dela para o caminho local:

```bash
npm install ../unbox-sdk   # grava file:../unbox-sdk; troque de volta antes de commitar
```

## Versionamento

Semver, com a convenção do `0.x`: `^0.1.0` aceita `0.1.x` e recusa `0.2.0`. Mudança de contrato
sobe a minor, e a loja escolhe quando entrar nela; correção sobe a patch e chega com
`npm update`.

## Licença

Proprietária. Veja [LICENSE.md](./LICENSE.md).

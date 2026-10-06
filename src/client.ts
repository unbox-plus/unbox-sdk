// UnboxClient — SDK headless da Unbox para Next.js / Vercel (server-side).
// Zero dependências: usa fetch nativo (Node 18+, Edge Runtime).
//
// ⚠️ Este client guarda a api key do parceiro e o token da loja — use APENAS no servidor
//    (Route Handlers, Server Actions, RSC). Nunca instancie no browser.
//
// UM ENDPOINT SÓ: partners.unbox.com.br/graphql, a API pública de PARCEIROS. Uma api key por
// PARCEIRO (vale para todas as lojas dele); a loja específica autentica por user/senha no
// `signIn`, e o JWT devolvido é o que identifica a loja em toda chamada seguinte.
//
// OS TRÊS CABEÇALHOS, e o que cada um resolve:
//   · x-api-key        → a api key do PARCEIRO. Vai em toda chamada, sem exceção.
//   · Authorization    → o token da LOJA (o do signIn). É dele que o gateway extrai o shopId.
//   · x-customer-token → o token do CLIENTE final (o do customerPasswordlessSignIn), só nas
//                        operações da área do cliente. Ver UnboxCustomerClient (customer.ts).
// É por isso que NENHUMA operação daqui manda shopId. As únicas exceções são os campos que o
// próprio schema de parceiros declara explicitamente (o `shopId` de CreateCartByTemplateInput e o
// de cada fulfillmentGroup no placeOrder) — esses continuam indo porque são argumentos do contrato.
//
// CAPTCHA NÃO EXISTE MAIS AQUI. As operações protegidas por reCAPTCHA (`signIn`,
// `customerOTPRequest`, `customerPasswordlessSignIn`, `placeOrder`, `placePaymentLinkOrder` e os
// dois `setup*3DSTransaction`) recebem o token injetado na BORDA do gateway de parceiros. A loja
// não tem segredo de captcha para guardar nem header para montar. O que protege OTP e checkout de
// abuso é o rate-limit do BFF da loja, e sempre foi — o header nunca foi um captcha de verdade.
//
// Peculiaridades do gateway (validadas ao vivo): args opcionais não aceitam null (montar query
// só com args presentes); unions exigem __typename; Authorization aceita token puro E Bearer
// (a doc pública diz só puro — na prática ambos passam).

import type {
  UnboxConfig, AddressInput, CartItemInput, CartResult,
  PlaceOrderParams, FulfillmentOption, CatalogProduct, Connection,
  PaymentLinkConstraints, PaymentLinkItemInput, DeviceInput, SimpleInventoryInfo,
} from "./types.js";
import { withLeanSelection, normalizeThumbnails, ITEM_IMAGES, DETAILED_SUMMARY, SHIPPING_AND_TRACKING } from "./order.js";

const DEFAULTS = {
  // API pública de PARCEIROS — gateway na frente do core. Uma api key por parceiro
  // (vale p/ todas as lojas dele); a loja é autenticada pelo user/senha no signIn.
  partnerGqlUrl: "https://partners.unbox.com.br/graphql",
  language: "pt-BR",
};

/** Bloco do endereço de entrega dentro de `fulfillmentGroups`. É uma UNIÃO
 *  (`OrderFulfillmentGroupData`), e o servidor precisa resolver o tipo concreto em runtime.
 *  Medido: o front nativo da Unbox lê `data.shippingAddress` na conta do cliente (funciona lá),
 *  e a consulta por `referenceId` falhou em produção com "must resolve to an Object type".
 *  Como a falha derruba a consulta INTEIRA e não só o campo, quem consulta pede o endereço e,
 *  se o servidor não conseguir resolver, repete sem ele: a loja mostra o endereço onde a API
 *  entrega e a página do pedido nunca deixa de abrir. */
export const FULFILLMENT_GROUP_DATA =
  "data{__typename ... on ShippingOrderFulfillmentGroupData { shippingAddress{fullName address1 number neighborhood city region postal} } }";

function isUnionNotResolved(e: unknown): boolean {
  const msgs = e instanceof UnboxError
    ? [e.message, ...(e.errors ?? []).map((x: any) => x?.message ?? "")].join(" ")
    : String(e);
  return /must resolve to an Object type|Could not determine the exact type|Can't resolve/i.test(msgs);
}

/** Roda `exec` com o bloco de endereço; só repete sem ele se o erro for a união não resolvida. */
export async function withFulfillmentGroupAddress<T>(exec: (address: string) => Promise<T>): Promise<T> {
  try {
    return await exec(FULFILLMENT_GROUP_DATA);
  } catch (e) {
    if (!isUnionNotResolved(e)) throw e;
    console.warn("[unbox] fulfillmentGroups.data não resolveu no servidor: repetindo a consulta sem o endereço de entrega.");
    return await exec("");
  }
}

/** Código do erro lançado quando a Unbox não respondeu dentro do prazo (ver gql()). */
export const UNBOX_TIMEOUT = "TIMEOUT";
export function isUnboxTimeout(e: unknown): boolean {
  return e instanceof UnboxError && e.message === UNBOX_TIMEOUT;
}

/** placeOrder cria pedido + cobra cartão/gera Pix: passa por antifraude e adquirente e pode
 *  levar bem mais que os 15 s do timeout padrão. Abortar no cliente NÃO aborta no servidor —
 *  o pedido pode nascer depois que a loja já desistiu, e a tela liberava "Pagar" de novo
 *  (cobrança dupla, caso real). Prazo próprio, longo, e erro distinguível (UNBOX_TIMEOUT). */
export const PLACE_ORDER_TIMEOUT_MS = 90_000;

export class UnboxError extends Error {
  errors: any[];
  constructor(message: string, errors: any[] = []) {
    super(message);
    this.name = "UnboxError";
    this.errors = errors;
  }
}

/**
 * PRODUTO OCULTO NO PAINEL NÃO ENTRA EM VITRINE. `catalogItems` não aceita filtro de visibilidade e
 * devolve o produto oculto junto com os outros. A PDP já barrava (`notFound()`), as listagens não: o
 * produto seguia no catálogo e na home, com preço e botão de comprar, e quebrava só no clique.
 *
 * O filtro mora AQUI, no ponto por onde todo catálogo passa, e não em `mapCatalogItems`: ali ficariam
 * de fora quem lê os nós crus (relacionados da PDP, kits, ofertas do checkout, llms.txt, o seletor do
 * editor). `totalCount` desconta o que saiu desta página, senão o contador e a paginação da busca
 * prometem resultado que a página não mostra.
 */
function onlyVisibles<T extends { nodes?: any[]; totalCount?: number }>(conn: T): T {
  const nodes = conn?.nodes ?? [];
  const visibles = nodes.filter((n: any) => (n?.product ?? n)?.isVisible !== false);
  if (visibles.length === nodes.length) return conn;
  return {
    ...conn,
    nodes: visibles,
    totalCount: typeof conn.totalCount === "number" ? Math.max(0, conn.totalCount - (nodes.length - visibles.length)) : conn.totalCount,
  };
}

/** Erro que indica formato de Authorization rejeitado (gateway de parceiros). */
function isAuthSchemeError(errors: any[]): boolean {
  const msg = errors.map((e: any) => `${e.errorType ?? ""} ${e.message ?? ""}`).join(" ").toUpperCase();
  return /UNAUTHORIZED|NOT AUTHORIZED|ACCESS_DENIED|UNAUTHENTICATED|INVALID TOKEN|401|403/.test(msg);
}

/** Formato do Authorization que o gateway aceitou. É propriedade da API, não da instância, e o
 *  `getStoreClient()` da loja (ver store.ts) cria um UnboxClient NOVO a cada request: guardado no
 *  módulo, o formato é medido uma vez por processo em vez de nunca chegar a ser memorizado. */
let acceptedScheme: "bearer" | "raw" | null = null;

export class UnboxClient {
  partnerApiKey: string;
  partnerGqlUrl: string;
  shopId: string;
  language: string;
  timeoutMs: number;
  token: string | null = null;

  constructor(cfg: UnboxConfig) {
    this.partnerApiKey = cfg.partnerApiKey;
    this.partnerGqlUrl = cfg.partnerGqlUrl ?? DEFAULTS.partnerGqlUrl;
    this.shopId = cfg.shopId ?? "";
    this.language = cfg.language ?? DEFAULTS.language;
    this.timeoutMs = cfg.timeoutMs ?? 15000;
  }

  // -------------------------------------------------------------------- auth
  /**
   * Autentica com user/senha DA LOJA (mutation `signIn`) e guarda o access_token (JWT, ~24h).
   * Único header: a x-api-key do parceiro — ainda não existe token de loja para o Authorization,
   * e o captcha é injetado na borda do gateway.
   */
  async signIn(username: string, password: string): Promise<string> {
    const q = `mutation($i:SignInInput!){ signIn(input:$i){ access_token id_token } }`;
    const res = await fetch(this.partnerGqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.partnerApiKey,
      },
      body: JSON.stringify({ query: q, variables: { i: { username, password } } }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = await res.json();
    if (json.errors?.length) {
      throw new UnboxError(`signIn: ${json.errors.map((e: any) => e.message).join(" | ")}`, json.errors);
    }
    const token = json.data?.signIn?.access_token;
    if (!token) throw new UnboxError("signIn sem access_token");
    this.token = token;
    return token as string;
  }

  setToken(token: string) { this.token = token; }

  // ------------------------------------------------------------- GraphQL (low)
  /**
   * Chamada à API de PARCEIROS.
   *
   * `Authorization` leva SEMPRE o token da LOJA — é dele que o gateway extrai o shopId, e por
   * isso nenhuma consulta precisa passá-lo. `opts.customerToken` acrescenta `x-customer-token`,
   * que é como as operações da área do cliente dizem DE QUEM é a conta. Os dois convivem na mesma
   * requisição: a loja no Authorization, o cliente no header próprio (ver customer.ts).
   *
   * FORMATO DO AUTHORIZATION. A doc oficial manda o token PURO, sem "Bearer ", e é por ele que
   * começamos; o outro formato fica como defesa se o gateway mudar. Enquanto o formato não foi
   * medido, uma CONSULTA que falhar por auth é repetida no outro formato, e o que funcionar fica
   * memorizado no módulo.
   *
   * MUTAÇÃO NUNCA REPETE. `isAuthSchemeError` casa por texto, e "not authorized" também é o que
   * a adquirente responde num cartão recusado: repetir um `placeOrder` por causa disso seria
   * criar o segundo pedido e cobrar duas vezes. Sem formato medido, uma consulta leve mede antes,
   * e só então a mutação vai, uma vez.
   */
  async gql<T = any>(
    query: string,
    variables: Record<string, any> = {},
    opts: { token?: string; customerToken?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    const token = opts.token ?? this.token;
    if (!token) throw new UnboxError("sem token da loja: chame signIn() ou setToken()");
    const isMutation = /^\s*mutation\b/.test(query);
    if (isMutation && !acceptedScheme) {
      await this.gql(`query{ shopBySlug{ _id } }`, {}, { token }).catch(() => null);
    }
    const attempt = async (scheme: "bearer" | "raw"): Promise<{ json: any }> => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-api-key": this.partnerApiKey,
        // Doc oficial: token PURO no Authorization (sem "Bearer ").
        Authorization: scheme === "raw" ? String(token) : `Bearer ${token}`,
      };
      if (opts.customerToken) headers["x-customer-token"] = opts.customerToken;
      let res: Response;
      try {
        res = await fetch(this.partnerGqlUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
        });
      } catch (e: any) {
        // Timeout vira um UnboxError reconhecível (código TIMEOUT). Quem chama decide o que fazer:
        // em leitura, tanto faz; em placeOrder, é a diferença entre "tente de novo" e "NÃO pague de novo".
        if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new UnboxError(UNBOX_TIMEOUT, [{ message: UNBOX_TIMEOUT }]);
        throw e;
      }
      const json = await res.json().catch(() => ({ errors: [{ message: `resposta que não é JSON (HTTP ${res.status})` }] }));
      return { json };
    };
    const primeiro = acceptedScheme ?? "raw";
    let { json } = await attempt(primeiro);
    if (!json.errors?.length) {
      acceptedScheme = primeiro;
    } else if (!acceptedScheme && !isMutation && isAuthSchemeError(json.errors)) {
      const outro = primeiro === "raw" ? "bearer" : "raw";
      const segunda = await attempt(outro);
      if (!segunda.json.errors?.length) {
        acceptedScheme = outro;
        console.warn(`[unbox] o gateway aceitou o Authorization no formato "${outro}", e ele fica memorizado`);
        json = segunda.json;
      }
    }
    if (json.errors?.length) {
      throw new UnboxError(json.errors.map((e: any) => e.message).join(" | "), json.errors);
    }
    return json.data as T;
  }

  // ------------------------------------------------------------------- catálogo
  private static CATALOG_PRODUCT_FIELDS = `
          _id productId title slug productType isVisible isSoldOut isBackorder isLowQuantity recurrenceAllowed imageUrls
          minOrderQuantity maxOrderQuantity tagIds
          pricing{displayPrice price minPrice maxPrice}
          variants{_id title sku pricing{price displayPrice compareAtPrice{displayAmount}}}`;

  async getCatalog(opts: {
    first?: number; offset?: number; searchText?: string; tagIds?: string[];
    sortBy?: string; sortOrder?: "asc" | "desc";
  } = {}): Promise<Connection<{ product: CatalogProduct }>> {
    // Sem shopIds (a loja vem do JWT). Diferenças do gateway (validadas ao vivo):
    // 1) args opcionais NÃO podem ir nulos (o resolver rejeita sortOrder:null) → montamos a
    //    query só com os args realmente presentes;
    // 2) o union CatalogItem exige __typename na seleção pra resolver o tipo.
    const decl = ["$first:Int", "$offset:Int"];
    const args = ["first:$first", "offset:$offset"];
    const vars: Record<string, any> = { first: opts.first ?? 24, offset: opts.offset ?? 0 };
    const opt = (name: string, type: string, value: any) => {
      if (value === undefined || value === null) return;
      decl.push(`$${name}:${type}`); args.push(`${name}:$${name}`); vars[name] = value;
    };
    opt("searchText", "String", opts.searchText);
    opt("tagIds", "[ID]", opts.tagIds);
    opt("sortBy", "CatalogItemSortByField", opts.sortBy);
    opt("sortOrder", "SortOrder", opts.sortOrder);
    const q = `query(${decl.join(",")}){
      catalogItems(${args.join(",")}){
        totalCount pageInfo{hasNextPage endCursor}
        nodes{__typename ... on CatalogItemProduct{ _id shortDescription product{${UnboxClient.CATALOG_PRODUCT_FIELDS}
        }}}
      }}`;
    const d = await this.gql<{ catalogItems: any }>(q, vars);
    return onlyVisibles(d.catalogItems);
  }

  private static PDP_PRODUCT_FIELDS = `_id productId title pageTitle slug description additionalInformation productType
          sku isVisible isSoldOut isBackorder isLowQuantity recurrenceAllowed
          minOrderQuantity maxOrderQuantity imageUrls videoUrls tagIds metaDescription
          pricing{displayPrice price minPrice maxPrice}
          variants{_id title sku pricing{price displayPrice compareAtPrice{displayAmount}}}`;

  async getProductBySlug(productSlug: string): Promise<any> {
    const q = `query($productSlug:String!){
      catalogItemProductBySlug(productSlug:$productSlug,filterSoldOutVariants:false){
        _id shortDescription cardDescription publishedUrl
        product{ ${UnboxClient.PDP_PRODUCT_FIELDS} }}}`;
    const d = await this.gql<{ catalogItemProductBySlug: any }>(q, { productSlug });
    return d.catalogItemProductBySlug;
  }

  /** PDP por productId — fallback/deep link.
   *  `catalogItemProductById` não existe na API de parceiros; o equivalente validado ao vivo é
   *  `catalogItems(productIdsOrERPCodes:[id], first:1)`, que devolve o mesmo CatalogItemProduct. */
  async getProductById(productId: string): Promise<any> {
    const q = `query($ids:[String]){
      catalogItems(productIdsOrERPCodes:$ids,first:1){
        nodes{__typename ... on CatalogItemProduct{ _id shortDescription publishedUrl
          product{ ${UnboxClient.PDP_PRODUCT_FIELDS} }}}}}`;
    const d = await this.gql<{ catalogItems: any }>(q, { ids: [productId] });
    return d.catalogItems?.nodes?.[0] ?? null;
  }

  // isTopLevel omitido = sem filtro (igual à vitrine padrão da Unbox). Forçar `true` esconde
  // categorias reais e visíveis marcadas isTopLevel:false no admin (ex.: "Acessórios") — 404
  // em /categoria/<slug> mesmo com o produto corretamente vinculado à categoria.
  async getTags(isTopLevel?: boolean): Promise<any[]> {
    const q = `query($isTopLevel:Boolean){
      tags(isTopLevel:$isTopLevel,shouldIncludeInvisible:false,shouldIncludeDeleted:false,first:100){
        nodes{_id name displayTitle slug description isTopLevel isVisible position subTagIds featuredProductIds}
      }}`;
    const d = await this.gql<{ tags: any }>(q, { isTopLevel });
    return d.tags.nodes;
  }

  // ----------------------------------------------------------------------- loja
  /** Dados da loja: promoções (shopSales), política de assinatura, settings, pagamentos.
   *  `shopBySlug` não recebe argumento — a loja vem do JWT, e o `slug` que chega aqui serve só
   *  para quem chama continuar falando em termos de loja. */
  async getShop(_slug?: string): Promise<any> {
    const q = `query{ shopBySlug{
      _id name slug acceptsBoleto acceptsCreditCard
      settings{maxInstallments allowAnonymousRecurringOrders allowLegalPersonSales showOutOfStockCatalogs}
      shopSales{_id code label description discountMethod enabled createdAt
        calculation{__typename ... on CalculationFreeItemByTier { tiers { cartSubtotalGTE catalogProductVariant { _id title } } }}}
      recurringOrdersPolicy{_id enabled keepOrderPricingPolicy
        allowedFrequencies{_id title periodicity interval}
        pricingPolicy{type value}
        customerActions{canSkipCycle canPause canChangeFrequency canChangeAddress canAddProducts canRemoveProducts canChangeProductQuantity}}
    }}`;
    const d = await this.gql<{ shopBySlug: any }>(q);
    return d.shopBySlug;
  }

  /** Métodos de pagamento habilitados no checkout desta loja. Sem argumento: a loja sai do JWT,
   *  e o próprio resolver já filtra por loja, ativação e região. */
  async getPaymentMethods(): Promise<any[]> {
    const q = `query{availablePaymentMethods{name displayName isEnabled canRefund pluginName}}`;
    const d = await this.gql<{ availablePaymentMethods: any[] }>(q);
    return d.availablePaymentMethods;
  }

  // ------------------------------------------------------------------ promoções
  async listDiscountCodes(first = 50): Promise<Connection<any>> {
    const q = `query($first:Int){ discountCodes(first:$first){
      totalCount nodes{_id code label description enabled discountMethod calculation{__typename}} }}`;
    const d = await this.gql<{ discountCodes: any }>(q, { first });
    return d.discountCodes;
  }

  // -------------------------------------------------------------------- carrinho
  // ⚠️ Schema LIVE: `recurringItemsFrequencyId` NÃO existe em CreateCartInput/AddCartItemsInput
  //    (diverge da doc — vale o live). Itens de assinatura marcam-se só com `isRecurring:true`;
  //    a FREQUÊNCIA vai no placeOrder (orderRecurrence.recurringItemsFrequencyId).
  async createCart(items: CartItemInput[]): Promise<CartResult> {
    const q = `mutation($i:CreateCartInput!){ createCart(input:$i){
      token
      cart{ _id totalItemQuantity expiresAt
        items{edges{node{_id productConfiguration{productId productVariantId} title variantTitle quantity thumbnail price{amount displayAmount} isRecurring isDiscountedBonusItem}}}
        checkout{fulfillmentGroups{_id} summary{itemTotal{displayAmount} total{amount displayAmount}}}}
      incorrectPriceFailures{productConfiguration{productId} providedPrice{amount} currentPrice{amount}}
      minOrderQuantityFailures{minOrderQuantity quantity}
      maxOrderQuantityFailures{maxOrderQuantity quantity} }}`;
    const d = await this.gql<{ createCart: any }>(q, { i: {
      items: items.map((it) => ({
        price: { amount: it.price, currencyCode: it.currencyCode ?? "BRL" },
        productConfiguration: { productId: it.productId, productVariantId: it.productVariantId },
        quantity: it.quantity,
        isRecurring: it.isRecurring ?? false,
        thumbnail: it.thumbnail ?? "",
      })),
    } });
    const r = d.createCart;
    // Obs.: o servidor SOBRESCREVE o preço com o do catálogo; incorrectPriceFailures vem vazio na
    // prática (ver types.ts). Mantido só como aviso defensivo — quantidade min/max sim pode falhar.
    if (r.incorrectPriceFailures?.length) console.warn("[unbox] incorrectPriceFailures:", r.incorrectPriceFailures);
    return {
      cartId: r.cart._id, cartToken: r.token, cart: r.cart,
      incorrectPriceFailures: r.incorrectPriceFailures,
      minOrderQuantityFailures: r.minOrderQuantityFailures,
      maxOrderQuantityFailures: r.maxOrderQuantityFailures,
    };
  }

  /** Adiciona itens a um carrinho existente (exige cartId + cartToken). isRecurring marca assinatura. */
  async addCartItems(cartId: string, cartToken: string, items: CartItemInput[]): Promise<any> {
    const q = `mutation($i:AddCartItemsInput!){ addCartItems(input:$i){
      cart{ _id totalItemQuantity items{edges{node{_id productConfiguration{productId productVariantId} title variantTitle quantity price{amount displayAmount} isRecurring isDiscountedBonusItem}}} }
      cartEvents{type data}
      minOrderQuantityFailures{minOrderQuantity quantity} maxOrderQuantityFailures{maxOrderQuantity quantity} }}`;
    const d = await this.gql<{ addCartItems: any }>(q, { i: {
      cartId, cartToken,
      items: items.map((it) => ({
        price: { amount: it.price, currencyCode: it.currencyCode ?? "BRL" },
        productConfiguration: { productId: it.productId, productVariantId: it.productVariantId },
        quantity: it.quantity, isRecurring: it.isRecurring ?? false, thumbnail: it.thumbnail ?? "",
      })),
    } });
    return d.addCartItems;
  }

  /** Altera a quantidade de um item do carrinho (cartItemId = node._id do item). */
  async updateItemQuantity(cartId: string, cartToken: string, cartItemId: string, quantity: number): Promise<any> {
    const q = `mutation($i:UpdateCartItemsQuantityInput!){ updateCartItemsQuantity(input:$i){
      cart{ _id totalItemQuantity } cartEvents{type data} }}`;
    const d = await this.gql<{ updateCartItemsQuantity: any }>(q, { i: { cartId, cartToken, items: [{ cartItemId, quantity }] } });
    return d.updateCartItemsQuantity;
  }

  /** Remove itens do carrinho (cartItemIds = node._id dos itens). */
  async removeCartItems(cartId: string, cartToken: string, cartItemIds: string[]): Promise<any> {
    const q = `mutation($i:RemoveCartItemsInput!){ removeCartItems(input:$i){
      cart{ _id totalItemQuantity } cartEvents{type data} }}`;
    const d = await this.gql<{ removeCartItems: any }>(q, { i: { cartId, cartToken, cartItemIds } });
    return d.removeCartItems;
  }

  /**
   * Recarrega um carrinho anônimo (rehidratar a sessão). Retorna o cart completo: itens,
   * brindes, resumo com descontos, e o endereço de entrega já gravado (se houver).
   */
  async getCart(cartId: string, cartToken: string): Promise<any> {
    const q = `query($cartId:ID!,$cartToken:String!){ anonymousCartByCartId(cartId:$cartId,cartToken:$cartToken){
      _id email expiresAt referenceId recurringItemsFrequencyId totalItemQuantity
      items(first:100){ totalCount edges{node{
        _id productConfiguration{productId productVariantId} title variantTitle quantity addedAt
        thumbnail price{amount displayAmount} isRecurring isDiscountedBonusItem }}}
      checkout{
        fulfillmentGroups{_id selectedFulfillmentOption{fulfillmentMethod{_id displayName name} price{displayAmount}}
          data{shippingAddress{fullName taxPayerId phone address1 address2 number neighborhood city region postal}}}
        summary{itemTotal{displayAmount} discountTotal{displayAmount} fulfillmentTotal{displayAmount} taxTotal{displayAmount} total{amount displayAmount}}} }}`;
    const d = await this.gql<{ anonymousCartByCartId: any }>(q, { cartId, cartToken });
    return d.anonymousCartByCartId;
  }

  /**
   * Grava o e-mail no carrinho anônimo (etapa de contato do checkout, antes do placeOrder).
   * Habilita recuperação de CARRINHO ABANDONADO: o e-mail fica associado ao cart no servidor
   * mesmo se o cliente não finalizar (capturado do storefront oficial — setEmailOnAnonymousCart).
   */
  async setEmailOnCart(cartId: string, cartToken: string, email: string): Promise<any> {
    const q = `mutation($i:SetEmailOnAnonymousCartInput!){ setEmailOnAnonymousCart(input:$i){
      cart{_id email} }}`;
    const d = await this.gql<{ setEmailOnAnonymousCart: any }>(q, { i: { cartId, cartToken, email } });
    return d.setEmailOnAnonymousCart;
  }

  async setShippingAddress(cartId: string, cartToken: string, address: AddressInput): Promise<string> {
    const q = `mutation($i:SetShippingAddressOnCartInput!){ setShippingAddressOnCart(input:$i){
      cart{checkout{fulfillmentGroups{_id}}} }}`;
    const d = await this.gql<{ setShippingAddressOnCart: any }>(q, {
      i: { cartId, cartToken, address: { country: "BR", ...address } },
    });
    return d.setShippingAddressOnCart.cart.checkout.fulfillmentGroups[0]._id;
  }

  /** Retorna TODOS os fulfillmentGroups do carrinho (suporte a N grupos de entrega). */
  async getFulfillmentGroupIds(cartId: string, cartToken: string): Promise<string[]> {
    const q = `query($cartId:ID!,$cartToken:String!){ anonymousCartByCartId(cartId:$cartId,cartToken:$cartToken){
      checkout{fulfillmentGroups{_id}} }}`;
    const d = await this.gql<{ anonymousCartByCartId: any }>(q, { cartId, cartToken });
    return (d.anonymousCartByCartId?.checkout?.fulfillmentGroups ?? []).map((g: any) => g._id);
  }

  /** Cota o frete de UM grupo. OBRIGATÓRIO após setShippingAddress (senão options vem vazio). */
  async quoteShipping(cartId: string, cartToken: string, fulfillmentGroupId: string): Promise<FulfillmentOption[]> {
    const q = `mutation($i:UpdateFulfillmentOptionsForGroupInput!){ updateFulfillmentOptionsForGroup(input:$i){
      cart{checkout{fulfillmentGroups{_id availableFulfillmentOptions{
        price{amount displayAmount} discountPrice{displayAmount}
        fulfillmentMethod{_id name displayName daysToDeliver}}}}} }}`;
    const d = await this.gql<{ updateFulfillmentOptionsForGroup: any }>(q, { i: { cartId, cartToken, fulfillmentGroupId } });
    const groups = d.updateFulfillmentOptionsForGroup.cart.checkout.fulfillmentGroups;
    const fg = groups.find((g: any) => g._id === fulfillmentGroupId) ?? groups[0];
    return fg.availableFulfillmentOptions ?? [];
  }

  async applyDiscount(cartId: string, cartToken: string, discountCode: string): Promise<any> {
    const q = `mutation($i:ApplyDiscountCodeToCartInput!){ applyDiscountCodeToCart(input:$i){
      cart{_id checkout{summary{discountTotal{displayAmount} total{amount displayAmount}}}} cartEvents{type data} }}`;
    const d = await this.gql<{ applyDiscountCodeToCart: any }>(q, { i: { cartId, token: cartToken, discountCode } });
    return d.applyDiscountCodeToCart;
  }

  /**
   * Resolve o discount._id a partir do CÓDIGO do cupom (necessário p/ removeDiscountCodeFromCart,
   * já que o Cart lido não expõe os ids de desconto aplicados). Casa por code (case-insensitive).
   */
  async findDiscountIdByCode(code: string): Promise<string | null> {
    const list = await this.listDiscountCodes(100);
    const match = (list.nodes as any[]).find((d) => (d.code ?? "").toLowerCase() === code.toLowerCase());
    return match?._id ?? null;
  }

  /** Remove um cupom do carrinho. Usa o discountId (= discount._id), NÃO o code. */
  async removeDiscount(cartId: string, cartToken: string, discountId: string): Promise<any> {
    const q = `mutation($i:RemoveDiscountCodeFromCartInput!){ removeDiscountCodeFromCart(input:$i){
      cart{checkout{summary{discountTotal{displayAmount} total{amount displayAmount}}}} cartEvents{type data} }}`;
    const d = await this.gql<{ removeDiscountCodeFromCart: any }>(q, { i: { cartId, token: cartToken, discountId } });
    return d.removeDiscountCodeFromCart;
  }

  /** Seleciona o frete de UM grupo e devolve o estado final (itens + total) p/ o placeOrder. */
  async selectShipping(cartId: string, cartToken: string, fulfillmentGroupId: string, fulfillmentMethodId: string): Promise<any> {
    const q = `mutation($i:SelectFulfillmentOptionForGroupInput!){ selectFulfillmentOptionForGroup(input:$i){
      cart{
        items{edges{node{productConfiguration{productId productVariantId} title variantTitle price{amount} quantity addedAt thumbnail isDiscountedBonusItem}}}
        checkout{summary{itemTotal{displayAmount} discountTotal{displayAmount} fulfillmentTotal{displayAmount} total{amount displayAmount}}}} }}`;
    const d = await this.gql<{ selectFulfillmentOptionForGroup: any }>(q, { i: { cartId, cartToken, fulfillmentGroupId, fulfillmentMethodId } });
    return d.selectFulfillmentOptionForGroup.cart;
  }

  /**
   * Monta os `items` do placeOrder a partir do carrinho final. INCLUI brindes/itens promocionais:
   * a Unbox exige que os itens do fulfillmentGroup batam EXATAMENTE com os do carrinho no servidor
   * (senão FULFILLMENT_GROUP_AND_CART_ITEMS_DO_NOT_MATCH_ERROR). O valor cobrado é o total
   * autoritativo do servidor (payment.amount = summary.total), então incluir brindes não cobra a mais.
   */
  buildOrderItems(cart: any): PlaceOrderParams["items"] {
    return cart.items.edges
      .map((e: any) => e.node)
      .map((n: any) => ({
        addedAt: n.addedAt,
        price: n.price.amount,
        productConfiguration: n.productConfiguration,
        quantity: n.quantity,
        thumbnail: n.thumbnail ?? "",
        // ESSENCIAIS p/ casar com o carrinho — sem eles a Unbox lança
        // FULFILLMENT_GROUP_AND_CART_ITEMS_DO_NOT_MATCH (validado contra um pedido real).
        isRecurring: n.isRecurring ?? false,
        isDiscountedBonusItem: n.isDiscountedBonusItem ?? false,
      }));
  }

  /**
   * "Calcule o frete" para a PDP (fora do checkout). Cria um carrinho efêmero com 1 item,
   * grava o endereço (só CEP basta na prática p/ cotar) e cota o frete. Compõe primitivas
   * já validadas ao vivo — não depende de createShipmentQuote (que a API de parceiros não expõe).
   */
  async quoteShippingForProduct(item: CartItemInput, postal: string): Promise<FulfillmentOption[]> {
    const cart = await this.createCart([item]);
    const addr: AddressInput = {
      fullName: "Cotação", taxPayerId: "", postal, address1: "—", number: "0",
      neighborhood: "—", city: "—", region: "SP", phone: "00000000000",
    };
    const fgId = await this.setShippingAddress(cart.cartId, cart.cartToken, addr);
    return this.quoteShipping(cart.cartId, cart.cartToken, fgId);
  }

  // -------------------------------------------------------------------- checkout
  /** Opções de parcelamento (sem juros) para um valor — usado no cartão de crédito (não assinatura). */
  async getInstallments(amount: number): Promise<Array<{ installment: number; amount: number }>> {
    const q = `query($amount:Float!){ getInstallments(input:{amount:$amount}){ installments{installment amount} } }`;
    const d = await this.gql<{ getInstallments: { installments: any[] } }>(q, { amount });
    return (d.getInstallments?.installments ?? []).map((i: any) => ({ installment: i.installment, amount: i.amount }));
  }

  /** Cria o pedido (REAL). O captcha é injetado na borda do gateway — nada a enviar aqui. */
  async placeOrder(p: PlaceOrderParams): Promise<any> {
    // country é obrigatório (String!) tanto no shippingAddress quanto no billingAddress.
    const address = { country: "BR", ...p.address };
    // `PaymentInput.data` é AWSJSON. O scalar é assimétrico: na ENTRADA ele espera o JSON já
    // serializado em string, e na SAÍDA devolve o objeto puro. Mandar o objeto aqui faz o gateway
    // recusar o placeOrder na validação da variável, antes de qualquer cobrança.
    const payment = p.payment.type === "pix"
      ? { amount: p.total, method: "unboxpay_pix", data: JSON.stringify({ paymentType: "pix" }), billingAddress: address }
      : {
          amount: p.total, method: "unboxpay_credit", billingAddress: address,
          data: JSON.stringify({
            cardHolder: p.payment.card.cardHolder, cardNumber: p.payment.card.cardNumber,
            expirationMonth: p.payment.card.expirationMonth, expirationYear: p.payment.card.expirationYear,
            securityCode: p.payment.card.securityCode, installments: p.payment.card.installments ?? 1,
            paymentType: "credit",
          }),
        };
    // device (antifraude/3DS) é OBRIGATÓRIO e vai no NÍVEL RAIZ do PlaceOrderInput
    // (irmão de order/payments). Sem navegador (scripts), o fallback é { type: "API" }.
    const device: DeviceInput = p.device ?? { type: "API" };
    const input: any = {
      // OrderInput não tem shopId (vem do JWT), mas OrderFulfillmentGroupInput declara
      // `shopId: ID!` — é argumento explícito do contrato, então continua indo.
      order: {
        cartId: p.cartId, currencyCode: "BRL", email: p.email,
        fulfillmentGroups: [{
          type: "SHIPPING", shopId: this.shopId, totalPrice: p.total,
          selectedFulfillmentMethodId: p.fulfillmentMethodId,
          data: { shippingAddress: address }, items: p.items,
        }],
      },
      payments: [payment],
      device,
    };
    if (p.recurrence) input.orderRecurrence = { createNewRecurringOrder: true, recurringItemsFrequencyId: p.recurrence.recurringItemsFrequencyId };

    const q = `mutation($i:PlaceOrderInput!){ placeOrder(input:$i){
      token orders{_id referenceId status summary{total{amount displayAmount}}
        recurringOrderId generatedNewRecurringOrder
        payments{method{name} status{status} captureErrorMessage
          data{__typename ... on UnboxPayPaymentData{qrCode paymentRecord redirectUrl numberOfInstallments}}}} }}`;
    const d = await this.gql<{ placeOrder: any }>(q, { i: input }, { timeoutMs: PLACE_ORDER_TIMEOUT_MS });
    return d.placeOrder;
  }

  /**
   * Acompanhar pedido pelo referenceId.
   * ⚠️ SEGURANÇA: com o token de LOJA, isto retorna QUALQUER pedido só pelo referenceId (validado
   * ao vivo) — referenceId é curto e adivinhável, e `orderByReferenceId` nem recebe token de posse.
   * NUNCA exponha esta chamada ao browser sem antes o BFF da loja verificar a POSSE do pedido:
   * compare o `token` devolvido pelo placeOrder (guardado em cookie httpOnly assinado) ou use o
   * token do cliente logado (`UnboxCustomerClient.order`).
   */
  async getOrder(referenceId: string): Promise<any> {
    // Seleção COMPLETA (quebra do total, envio, rastreio e status do pagamento) com volta para a
    // ENXUTA se a API recusar: ver withLeanSelection em ./pedido. Notas:
    //   · `OrderItem` tem `imageURLs` (objeto de tamanhos); a normalização devolve o `thumbnail`
    //     que o app lê.
    //   · `trackingUrl` não existe em Order, mas `fulfillmentGroups.tracking.url` existe
    //     (OrderTrackingData { code, url, event }).
    //   · fora displayStatus e payments.data, resolvedores que derrubam a consulta inteira.
    //   · `payments` sempre junto de `summary` (ver customer.ts, orders()).
    const selection = (address: string, rich: boolean) => `query($id:ID!){ orderByReferenceId(id:$id){
          _id referenceId status email${rich ? " createdAt" : ""}
          summary{total{amount displayAmount}${rich ? DETAILED_SUMMARY : ""}}
          payments{displayName mode processor isCaptured cardBrand captureErrorMessage amount{displayAmount}${rich ? " status{status}" : ""}}
          fulfillmentGroups{
            status type trackingCode
            ${rich ? SHIPPING_AND_TRACKING : ""}
            ${address}
            items{nodes{_id title variantTitle quantity ${ITEM_IMAGES} productSlug price{amount displayAmount} subtotal{displayAmount} productConfiguration{productId productVariantId}}}
          }
          invoiceIssued dispatched delivered
          recurringOrderId } }`;

    const query = (rich: boolean) => withFulfillmentGroupAddress((address) =>
      this.gql<{ orderByReferenceId: any }>(selection(address, rich), { id: referenceId }));
    const d = await withLeanSelection("orderByReferenceId", () => query(true), () => query(false));
    return normalizeThumbnails(d.orderByReferenceId);
  }

  // -------------------------------------------------------- conta do cliente (OTP)
  // As três operações abaixo são de PRÉ-LOGIN: acontecem quando ainda não existe token de
  // cliente, então vão só com o token da LOJA no Authorization. O `x-customer-token` entra
  // depois, nas operações do cliente já autenticado (customer.ts). As duas primeiras são
  // protegidas por captcha do lado da Unbox, injetado na borda do gateway.

  /** Storefront pede OTP por e-mail. O captcha é injetado na borda do gateway. */
  async requestCustomerOtp(email: string): Promise<boolean> {
    const q = `mutation($i:CustomerOTPRequestInput!){ customerOTPRequest(input:$i){success} }`;
    const d = await this.gql<{ customerOTPRequest: { success: boolean } }>(q, { i: { email } });
    return d.customerOTPRequest.success;
  }

  /** Troca o OTP pelo token DO CLIENTE — é ele que vira o `x-customer-token` das chamadas da
   *  área do cliente (use-o no UnboxCustomerClient). */
  async customerSignIn(email: string, otp: string): Promise<{ accessToken: string; firstAccess: boolean }> {
    const q = `mutation($i:CustomerPasswordlessSignInInput){ customerPasswordlessSignIn(input:$i){
      accessToken idToken firstAccess newShopSignIn }}`;
    const d = await this.gql<{ customerPasswordlessSignIn: any }>(q, { i: { email, otp } });
    return { accessToken: d.customerPasswordlessSignIn.accessToken, firstAccess: d.customerPasswordlessSignIn.firstAccess };
  }

  async customerAccountExists(email: string): Promise<boolean> {
    const q = `query($i:HasCustomerAccountInput){ hasCustomerAccount(input:$i){result} }`;
    const d = await this.gql<{ hasCustomerAccount: { result: boolean } }>(q, { i: { email } });
    return d.hasCustomerAccount.result;
  }

  async getAddressByPostalCode(postalCode: string): Promise<any> {
    const q = `query($i:getAddressByPostalCodeInput!){ getAddressByPostalCode(input:$i){
      address1 neighborhood city region cityCode }}`;
    const d = await this.gql<{ getAddressByPostalCode: any }>(q, { i: { postalCode: postalCode.replace(/\D/g, "") } });
    return d.getAddressByPostalCode;
  }

  // --------------------------------------------------------------- payment links
  /**
   * Cria um Payment Link hospedado pela Unbox (bom para WhatsApp / compartilhar carrinho).
   * ⚠️ Operação de loja (admin-ish) — rode sob demanda. Retorna o PaymentLink; a página pública
   * é montada via getPublicPaymentLink(paymentLinkId).
   *
   * Os itens do Payment Link são PRODUTOS VIRTUAIS (`PaymentLinkItemInput`): título, quantidade e
   * preço são do link, e o vínculo com o catálogo, quando existe, é por código de ERP. Não é o
   * mesmo formato de um item de carrinho (productId/productVariantId).
   */
  async createPaymentLink(input: {
    title: string;
    items: PaymentLinkItemInput[];
    description?: string;
    constraints?: PaymentLinkConstraints;
    customerData?: Record<string, { value: string; editable: boolean }>;
  }): Promise<any> {
    const q = `mutation($i:CreatePaymentLinkInput!){ createPaymentLink(input:$i){
      _id referenceId status constraints{expirationDate usageLimit} }}`;
    const d = await this.gql<{ createPaymentLink: any }>(q, { i: {
      title: input.title,
      description: input.description,
      items: input.items,
      constraints: input.constraints,
      metadata: input.customerData ? { customerData: input.customerData } : undefined,
    } });
    return d.createPaymentLink;
  }

  /** Lê um payment link público (para montar a página de pagamento). discountCode é aplicado aqui. */
  async getPublicPaymentLink(paymentLinkId: string, discountCode?: string): Promise<any> {
    const q = `query($id:ID!,$discountCode:String){ publicPaymentLink(paymentLinkId:$id,discountCode:$discountCode){
      _id referenceId status }}`;
    const d = await this.gql<{ publicPaymentLink: any }>(q, { id: paymentLinkId, discountCode });
    return d.publicPaymentLink;
  }

  /** Cria um carrinho real a partir de um cart template (campanhas / "compre de novo").
   *  `CreateCartByTemplateInput` declara `shopId: ID!` explicitamente — por isso ele vai. */
  async createCartByTemplate(cartTemplateId: string): Promise<CartResult> {
    const q = `mutation($i:CreateCartByTemplateInput!){ createCartByTemplate(input:$i){
      token cart{ _id totalItemQuantity checkout{summary{total{amount displayAmount}}} } }}`;
    const d = await this.gql<{ createCartByTemplate: any }>(q, { i: { shopId: this.shopId, cartTemplateId } });
    const r = d.createCartByTemplate;
    return { cartId: r.cart._id, cartToken: r.token, cart: r.cart };
  }

  // -------------------------------------------------------------------- webhooks
  /** ⚠️ EFEITO REAL: cria uma assinatura de webhook na loja. Rode sob demanda (script). */
  async subscribeWebhook(eventType: string, endpoint: string): Promise<any> {
    const q = `mutation($i:SubscribeToWebhookInput){ subscribeToWebhook(input:$i){
      _id eventType endpoint secret createdAt }}`;
    const d = await this.gql<{ subscribeToWebhook: any }>(q, { i: { eventType, endpoint } });
    return d.subscribeToWebhook;
  }

  // ------------------------------------------------------------------ inventário
  /** Inventário de uma variante (simpleInventory). */
  async getSimpleInventory(productId: string, productVariantId: string): Promise<SimpleInventoryInfo | null> {
    const q = `query($pc:ProductConfigurationInput!){ simpleInventory(productConfiguration:$pc){
      _id canBackorder inventoryInStock inventoryReserved isEnabled lowInventoryWarningThreshold
      productConfiguration{productId productVariantId} }}`;
    const d = await this.gql<{ simpleInventory: SimpleInventoryInfo | null }>(q, { pc: { productId, productVariantId } });
    return d.simpleInventory ?? null;
  }
}

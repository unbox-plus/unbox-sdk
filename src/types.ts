// Tipos da API Unbox (headless commerce). Apenas tipos — apagados em runtime.

export interface Money {
  amount: number;
  displayAmount?: string;
  currency?: { code: string };
}

export interface UnboxConfig {
  /** API key do PARCEIRO (x-api-key). Uma só, vale para todas as lojas do parceiro; QUAL loja
   *  é o user/senha do signIn que diz. Server-only. */
  partnerApiKey: string;
  /** Endpoint GraphQL da API de parceiros. Default: https://partners.unbox.com.br/graphql */
  partnerGqlUrl?: string;
  /** shopId da loja (ex.: "8EaeSDX99hifhyTQp"). A API de parceiros resolve a loja pelo JWT que
   *  vai no Authorization: isto só é usado nos DOIS pontos em que o schema declara o shopId
   *  explicitamente (fulfillmentGroups do placeOrder e CreateCartByTemplateInput). */
  shopId?: string;
  /** Idioma de respostas/rótulos. Default: "pt-BR".
   *  ⚠️ displayStatus(language) tem resolver quebrado no live — use status cru + orderStatusLabel(). */
  language?: string;
  /** Timeout por request (ms). Default: 15000. Aplica a signin e a toda chamada GraphQL. */
  timeoutMs?: number;
}

export interface ProductVariant {
  _id: string;
  title: string;
  sku?: string | null;
  pricing?: Array<{ price: number | null; displayPrice: string; compareAtPrice?: { displayAmount: string } | null }>;
}

export interface CatalogProduct {
  _id: string;
  productId: string;
  title: string;
  slug: string;
  productType: string;
  isVisible: boolean;
  isSoldOut: boolean;
  isBackorder?: boolean;
  isLowQuantity?: boolean;
  recurrenceAllowed?: boolean;
  imageUrls?: string[];
  videoUrls?: string[];
  description?: string;
  additionalInformation?: string;
  pageTitle?: string;
  metaDescription?: string;
  tagIds?: string[];
  minOrderQuantity?: number | null;
  maxOrderQuantity?: number | null;
  pricing?: Array<{ displayPrice: string; price: number | null; minPrice: number; maxPrice: number }>;
  variants?: ProductVariant[];
}

export interface Connection<T> {
  totalCount: number;
  nodes: T[];
  pageInfo?: { hasNextPage: boolean; endCursor?: string };
}

export interface AddressInput {
  fullName: string;
  taxPayerId: string;
  postal: string;
  address1: string;
  number: string;
  neighborhood: string;
  city: string;
  region: string;
  phone: string;        // OBRIGATÓRIO (String!) — validado ao vivo
  country?: string;     // default "BR" aplicado pelo SDK
  address2?: string;
  cityCode?: string;
  isCommercial?: boolean;
  trackByMobile?: boolean;
}

export interface CartItemInput {
  productId: string;
  /** ⚠️ É `productVariantId`, NÃO `variantId`. Errar o nome (em payload montado à mão, fora
   *  deste tipo) devolve um erro de GraphQL que só cita `productConfiguration`, sem dizer
   *  qual campo faltou — armadilha clássica ao escrever testes contra a API. */
  productVariantId: string;
  /** Preço da variante. ⚠️ O servidor SOBRESCREVE com o preço do catálogo (validado ao vivo:
   *  enviar 0.01 grava o preço real e `incorrectPriceFailures` vem vazio). Envie o preço real
   *  por correção/UX, mas a fonte da verdade é o catálogo. */
  price: number;
  quantity: number;
  isRecurring?: boolean;
  thumbnail?: string;
  currencyCode?: string;
}

export interface FulfillmentOption {
  fulfillmentMethod: { _id: string; name: string; displayName?: string; daysToDeliver?: number };
  price: Money;
  discountPrice?: { displayAmount?: string };
}

export interface CartResult {
  cartId: string;
  cartToken: string;
  cart: any;
  incorrectPriceFailures?: any[];
  minOrderQuantityFailures?: Array<{ minOrderQuantity: number; quantity: number }>;
  maxOrderQuantityFailures?: Array<{ maxOrderQuantity: number; quantity: number }>;
}

export type PaymentType = "pix" | "credit" | "boleto";

/** Fingerprint antifraude/3DS exigido pela Unbox no placeOrder. Vai no NÍVEL RAIZ do
 *  PlaceOrderInput (irmão de `order` e `payments`), como campo único com enum `type`:
 *  - BROWSER: dados reais do navegador do comprador (coletados na tela de checkout da loja).
 *  - API: fallback para pedidos originados no servidor (scripts), sem navegador. */
export type DeviceInput =
  | {
      type: "BROWSER";
      colorDepth: number;
      javaEnabled: boolean;
      userAgent: string;
      language: string;
      screenHeight: number;
      screenWidth: number;
      /** ⚠️ Ponto aberto com a Unbox: enviamos MINUTOS (getTimezoneOffset(), BRT → 180),
       *  igual ao storefront de referência. A doc mostrava 3 (horas). Se a Unbox confirmar
       *  horas, dividir por 60 na coleta, no checkout da loja. Não quebra o pedido —
       *  afeta só o sinal de antifraude. */
      timezoneOffset: number;
    }
  | { type: "API" };

export interface CardData {
  cardHolder: string;
  cardNumber: string;
  expirationMonth: string;
  expirationYear: string;
  securityCode: string;
  installments?: number;
}

export interface PlaceOrderParams {
  cartId: string;
  email: string;
  address: AddressInput;
  fulfillmentMethodId: string;
  /** total final (cart.checkout.summary.total.amount após selecionar o frete). */
  total: number;
  /** itens finais do carrinho — TODOS (inclusive brindes), com os flags `isRecurring` e
   *  `isDiscountedBonusItem` (use buildOrderItems). Omitir os flags/brindes → 502 (ver buildOrderItems). */
  items: Array<{ productConfiguration: { productId: string; productVariantId: string }; price: number; quantity: number; addedAt?: string; thumbnail?: string; isRecurring?: boolean; isDiscountedBonusItem?: boolean }>;
  payment:
    | { type: "pix" }
    | { type: "card"; card: CardData };
  /** assinatura: cria recurring order. */
  recurrence?: { recurringItemsFrequencyId: string };
  /** fingerprint antifraude — omitido, o client envia { type: "API" } como fallback. */
  device?: DeviceInput;
}

/** Inventário de uma variante (API de parceiros — simpleInventory). */
export interface SimpleInventoryInfo {
  _id: string;
  canBackorder: boolean;
  inventoryInStock: number;
  inventoryReserved: number;
  isEnabled: boolean;
  lowInventoryWarningThreshold?: number | null;
  productConfiguration: { productId: string; productVariantId: string };
}

export interface SubscriptionFrequency {
  _id: string;
  title: string;
  periodicity: "DAY" | "WEEK" | "MONTH" | string;
  interval: number;
}

export interface PaymentLinkConstraints {
  expirationDate?: string;
  usageLimit?: number;
  /** PF, PJ ou ambos. Enum `BuyerTypesEnum` do schema de parceiros. */
  buyerTypes?: string[];
}

/** Item de um Payment Link (`PaymentLinkItemInput`). É um PRODUTO VIRTUAL: título, preço e
 *  quantidade são do link, e o vínculo com o catálogo, quando existe, é por código de ERP —
 *  não por productId/productVariantId, como no carrinho. */
export interface PaymentLinkItemInput {
  title: string;
  quantity: number;
  price: { amount: number; currencyCode: string };
  description?: string;
  images?: Array<{ file?: string; altText?: string }>;
  parcel?: { weight: number; height: number; width: number; length: number };
  productERPCode?: string;
  variantERPCode?: string;
}

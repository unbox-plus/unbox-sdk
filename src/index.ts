// @unbox-plus/sdk — a camada de comunicação com a API de PARCEIROS da Unbox.
//
// O que entra aqui: chamada à API, forma do dado que ela devolve, e a tradução dos códigos dela
// em texto que o cliente final entende. O que NÃO entra: framework. Nada neste pacote importa
// `next`, `react` ou `server-only` — a loja é que decide o que cachear, o que é rota e o que é
// componente. É essa fronteira que permite atualizar a integração com um bump de versão.
//
// ⚠️ SERVER-ONLY na prática: a api key do parceiro e o token da loja passam por aqui. Instanciar
// `UnboxClient` no browser entrega as duas ao visitante. A única parte que a loja pode levar ao
// navegador com segurança é a tradução de erro (`friendlyError`, `cartEventLabel`) e os rótulos
// de status, que são texto.
//
// O `node:crypto` da verificação de webhook mora em `@unbox-plus/sdk/webhooks`, e não neste
// índice, de propósito: importado no bundle do navegador, um builtin do Node derruba o build.

export {
  UnboxClient,
  UnboxError,
  UNBOX_TIMEOUT,
  isUnboxTimeout,
  PLACE_ORDER_TIMEOUT_MS,
  FULFILLMENT_GROUP_DATA,
  withFulfillmentGroupAddress,
} from "./client.js";

export {
  UnboxCustomerClient,
  orderStatusLabel, paymentStatusLabel, subscriptionStatusLabel,
  fulfillmentStatusLabel, fulfillmentTypeLabel, trackingStatusLabel, paymentSeal,
  ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS, SUBSCRIPTION_STATUS_LABELS,
  FULFILLMENT_STATUS_LABELS, FULFILLMENT_TYPE_LABELS, TRACKING_STATUS_LABELS, PAYMENT_SEAL_LABELS,
} from "./customer.js";

export {
  friendlyError, cartEventLabel, invalidAddressMessage,
  ERROR_MESSAGES, CART_EVENT_LABELS, ADDRESS_FIELD,
} from "./errors.js";

export {
  withLeanSelection, normalizeThumbnails, isSessionError,
  ITEM_IMAGES, DETAILED_SUMMARY, SHIPPING_AND_TRACKING,
} from "./pedido.js";

export {
  connectUnboxStore, credentialsFromEnv, hasUnboxCredentials, loadAllCatalogItems,
  MISSING_CREDENTIALS,
} from "./store.js";
export type {
  UnboxStore, UnboxCredentials, UnboxTokenStore, CachedToken, ShopContext,
} from "./store.js";

export {
  decodeJwtClaims, isJwtExpired, shopClaimsFromToken, SHOP_ID_CLAIM, SHOP_SLUG_CLAIM,
} from "./jwt.js";

export type * from "./types.js";

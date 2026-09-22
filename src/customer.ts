// UnboxCustomerClient — operações da ÁREA DO CLIENTE final, na API de PARCEIROS.
//
// DUAS IDENTIDADES NA MESMA REQUISIÇÃO, e é isso que este arquivo existe para amarrar:
//   · a LOJA, no `Authorization` — é dela que o gateway extrai o shopId, então nenhuma consulta
//     daqui precisa passá-lo;
//   · o CLIENTE final, no `x-customer-token` — é ele que diz DE QUEM é a conta, o pedido, o
//     endereço e a assinatura que a consulta devolve.
// Por isso o client do cliente logado carrega um UnboxClient de LOJA já autenticado: sem o token
// da loja não há contexto de loja, e sem o token do cliente não há conta. Server-only: roda num
// BFF/Route Handler, com o token do cliente vindo de um cookie httpOnly.
//
// A única exceção ao "nada de shopId" é o filtro `shopIds` de `customerRecurringOrders`, que o
// schema declara explicitamente (uma conta pode assinar em mais de uma loja do mesmo parceiro).

import { UnboxError, withFulfillmentGroupAddress, type UnboxClient } from "./client.js";
import { withLeanSelection, normalizeThumbnails, ITEM_IMAGES, DETAILED_SUMMARY, SHIPPING_AND_TRACKING } from "./pedido.js";
import type { AddressInput } from "./types.js";

const RECURRING_FIELDS = `
  _id referenceId shopId createdAt updatedAt customerAccountId unboxPayCustomerId
  status{value createdAt} frequency{_id title periodicity interval}
  pricingPolicy{type value}
  cyclesInformation{cycleCount skipNextCycle lastCycleDate nextCycleDate}
  items{productId variantId productERPCode variantERPCode quantity skipNextCycle}
  unboxPayCustomerCreditCard{first4Digits last4Digits expirationMonth expirationYear holderName}
  shippingAddressBook{_id fullName postal address1 number neighborhood city region}
  discount{discountId code} totalAmount{amount displayAmount}`;

export class UnboxCustomerClient {
  /** Token do CLIENTE final (o do `customerSignIn`). Vai no header `x-customer-token`. */
  customerToken: string;
  /** Cliente de LOJA já autenticado. É dele que saem o endpoint, a api key do parceiro e o
   *  `Authorization` com o token da loja — o que dá contexto de loja à consulta. */
  loja: UnboxClient;
  language: string;

  constructor(opts: { customerToken: string; loja: UnboxClient; language?: string }) {
    this.customerToken = opts.customerToken;
    this.loja = opts.loja;
    this.language = opts.language ?? this.loja.language;
  }

  /** shopId resolvido da loja — usado só no filtro `shopIds` das assinaturas. */
  get shopId(): string { return this.loja.shopId; }

  /** Toda consulta da área do cliente passa por aqui: mesmo transporte do client de loja
   *  (incluindo prazo, formato do Authorization e a regra de não repetir mutação), mais o
   *  `x-customer-token`. */
  async gql<T = any>(query: string, variables: Record<string, any> = {}): Promise<T> {
    return this.loja.gql<T>(query, variables, { customerToken: this.customerToken });
  }

  // --------------------------------------------------------------------- conta
  async me(): Promise<any> {
    // Sem argumento: a loja vem do Authorization (token da loja) e a CONTA vem do
    // `x-customer-token`. É o par de cabeçalhos que substitui o antigo `shopId` nas variables.
    const q = `query{ currentCustomerAccount{
      _id email isFirstAccess reuseDataBetweenShops metafields{receiveNewOrderEmail}
      addressBooks{_id alias fullName postal address1 number neighborhood city region isShippingDefault isBillingDefault}
      lastAddressUsed{_id postal address1 city region} }}`;
    const d = await this.gql<{ currentCustomerAccount: any }>(q);
    return d.currentCustomerAccount;
  }

  /** Atualiza preferências da conta (ex.: receiveNewOrderEmail, reuseDataBetweenShops).
   *  `receiveNewOrderEmail` mora dentro de `metafields` no input de parceiros. */
  async updateAccount(input: { receiveNewOrderEmail?: boolean; reuseDataBetweenShops?: boolean }): Promise<any> {
    const q = `mutation($i:UpdateCustomerAccountInput!){ updateCustomerAccount(input:$i){
      _id reuseDataBetweenShops metafields{receiveNewOrderEmail} }}`;
    const entrada: Record<string, any> = {};
    if (input.reuseDataBetweenShops !== undefined) entrada.reuseDataBetweenShops = input.reuseDataBetweenShops;
    if (input.receiveNewOrderEmail !== undefined) entrada.metafields = { receiveNewOrderEmail: input.receiveNewOrderEmail };
    const d = await this.gql<{ updateCustomerAccount: any }>(q, { i: entrada });
    return d.updateCustomerAccount;
  }

  // -------------------------------------------------------------------- pedidos
  // Campos que já custaram a consulta inteira (resolver que lança, e o campo é non-null):
  //   · displayStatus      → "reading 'status'"   (use `status` + orderStatusLabel())
  //   · totalItemQuantity  → "reading 'shop'"
  //   · shippingMethods    → "reading '0'"
  //   · summary sem payments → "reading '0'"
  //   · payments.amount.amount → "Cannot return null for non-nullable field Money.amount": o campo é
  //     non-null no schema e a Unbox manda null quando o pagamento não tem valor numérico. Um pedido
  //     assim apaga a lista inteira, e a volta para a seleção enxuta não salva se ela pedir o mesmo
  //     campo. Medido numa loja no ar: os 14 pedidos eram assim. Peça só `displayAmount`; o número que
  //     a tela usa vem de `summary`.
  // O último é o mais traiçoeiro. O resolver de `summary` lê `payments[0]?.summary`, e a projeção do
  // banco só traz `payments` quando a consulta PEDE `payments`. Pedir o total sem pedir o pagamento é
  // GraphQL válido que apaga a resposta: o cliente logado via a conta sem nenhum pedido. Por isso
  // `payments` vai junto de `summary` em toda seleção abaixo, mesmo onde a tela não usa o pagamento.
  async orders(opts: { first?: number; filters?: any } = {}): Promise<any> {
    const completa = (endereco: string) => `query($first:Int,$filters:CustomerOrderFilterInput){
      customerOrders(first:$first,filters:$filters,sortBy:_id,sortOrder:desc){
        totalCount pageInfo{hasNextPage endCursor}
        nodes{_id referenceId status createdAt
          recurringOrderId dispatched delivered isBoletoPaid invoiceIssued
          payments{amount{displayAmount}}
          summary{total{amount displayAmount}}
          fulfillmentGroups{
            ${endereco}
            items{nodes{_id title quantity productSlug ${ITEM_IMAGES} price{amount displayAmount}}}
          }} }}`;
    // Enxuta: só o que a lista lê, sem endereço e sem argumento opcional (a ordem padrão da API já é
    // a data de criação, da mais nova para a mais antiga).
    const enxuta = `query($first:Int){
      customerOrders(first:$first){
        totalCount
        nodes{_id referenceId status createdAt recurringOrderId dispatched delivered
          payments{amount{displayAmount}}
          summary{total{amount displayAmount}}
          fulfillmentGroups{items{nodes{_id title quantity productSlug ${ITEM_IMAGES} price{amount displayAmount}}}}
        } }}`;
    const d = await withLeanSelection(
      "customerOrders",
      () => withFulfillmentGroupAddress((endereco) => this.gql<{ customerOrders: any }>(completa(endereco), { first: opts.first ?? 20, filters: opts.filters })),
      () => this.gql<{ customerOrders: any }>(enxuta, { first: opts.first ?? 20 }),
    );
    for (const o of d.customerOrders?.nodes ?? []) normalizeThumbnails(o);
    return d.customerOrders;
  }

  /**
   * Os slugs dos produtos dos pedidos PAGOS (em processamento ou concluídos): é o que a personalização por
   * público confere no login (`lib/publico-do-cliente.ts`). Seleção mínima de propósito, porque roda com teto
   * de tempo; e sem `summary`, que sem `payments` apaga a resposta inteira (ver `orders`).
   */
  async purchasedProducts(first = 20): Promise<string[]> {
    const q = `query($first:Int){ customerOrders(first:$first){ nodes{ status fulfillmentGroups{ items{ nodes{ productSlug } } } } } }`;
    const d = await this.gql<{ customerOrders: { nodes?: any[] } | null }>(q, { first });
    const slugs = new Set<string>();
    for (const o of d.customerOrders?.nodes ?? []) {
      if (o?.status !== "PROCESSING" && o?.status !== "COMPLETED") continue;
      for (const g of o?.fulfillmentGroups ?? []) {
        for (const i of g?.items?.nodes ?? []) if (typeof i?.productSlug === "string" && i.productSlug) slugs.add(i.productSlug.toLowerCase());
      }
    }
    return [...slugs];
  }

  async order(referenceId: string): Promise<any> {
    // Notas do schema (contexto de cliente):
    //   · payments.data (PaymentData) fica FORA.
    //   · fulfillmentGroups.data é a união OrderFulfillmentGroupData: entra pelo withFulfillmentGroupAddress,
    //     que repete a consulta sem o campo se o servidor não resolver o tipo.
    //   · `trackingUrl` não existe em Order, mas `fulfillmentGroups.tracking` é OrderTrackingData
    //     { code, url, event }: tem o link da transportadora e o histórico (`event.value` é o estado
    //     atual, `event.history` os anteriores).
    //   · FulfillmentMethod: `displayName` e `name` são String! no schema e voltam null nos dados
    //     ("Cannot return null for non-nullable field"), derrubando a consulta. Só os anuláveis.
    const selecao = (endereco: string, rica: boolean) => `query($referenceId:ID!){
      customerOrderByReferenceId(referenceId:$referenceId){
        _id referenceId status email createdAt
        summary{total{amount displayAmount}${rica ? DETAILED_SUMMARY : ""}}
        discounts{code label discount discountMethod}
        payments{displayName mode processor isCaptured cardBrand captureErrorMessage amount{displayAmount}${rica ? " status{status}" : ""}}
        fulfillmentGroups{
          status type trackingCode
          ${rica ? SHIPPING_AND_TRACKING : ""}
          ${endereco}
          items{nodes{_id title variantTitle quantity ${ITEM_IMAGES} productSlug price{amount displayAmount} subtotal{displayAmount} productConfiguration{productId productVariantId}}}
        }
        recurringOrderId generatedNewRecurringOrder }}`;
    const vars = { referenceId };
    const d = await withLeanSelection(
      "customerOrderByReferenceId",
      () => withFulfillmentGroupAddress((endereco) => this.gql<{ customerOrderByReferenceId: any }>(selecao(endereco, true), vars)),
      () => withFulfillmentGroupAddress((endereco) => this.gql<{ customerOrderByReferenceId: any }>(selecao(endereco, false), vars)),
    );
    return normalizeThumbnails(d.customerOrderByReferenceId);
  }

  // ----------------------------------------------------------------- assinaturas
  async subscriptions(opts: { first?: number; status?: string[] } = {}): Promise<any> {
    const q = `query($filters:CustomerRecurringOrdersFilterInput,$first:Int){
      customerRecurringOrders(filters:$filters,first:$first){
        totalCount nodes{_id referenceId shopId createdAt unboxPayCustomerId} }}`;
    // `shopIds` é filtro EXPLÍCITO do schema e continua valendo: a mesma conta pode assinar em
    // mais de uma loja do parceiro, e a conta desta loja só mostra as daqui.
    const filters: Record<string, any> = {};
    if (opts.status) filters.status = opts.status;
    if (this.shopId) filters.shopIds = [this.shopId];
    const d = await this.gql<{ customerRecurringOrders: any }>(q, { first: opts.first ?? 10, filters });
    return d.customerRecurringOrders;
  }

  async subscription(referenceId: string): Promise<any> {
    const q = `query($referenceId:String!){ customerRecurringOrderByReferenceId(referenceId:$referenceId){${RECURRING_FIELDS}} }`;
    const d = await this.gql<{ customerRecurringOrderByReferenceId: any }>(q, { referenceId });
    return d.customerRecurringOrderByReferenceId;
  }

  async subscriptionCycles(recurringOrderId: string, first = 20): Promise<any> {
    const q = `query($filters:RecurringOrderCyclesFilterInput!,$first:Int){
      customerRecurringOrderCycles(filters:$filters,first:$first){
        totalCount nodes{_id cycleIndex completedAt skipped attemptingRetry manuallyRetried createdAt} }}`;
    const d = await this.gql<{ customerRecurringOrderCycles: any }>(q, { filters: { recurringOrderId }, first });
    return d.customerRecurringOrderCycles;
  }

  /** Pausar/retomar assinatura (toggle — valida ao vivo: customerTogglePauseRecurringOrder). */
  pause(recurringOrderId: string) {
    return this.gql(`mutation($id:String!){customerTogglePauseRecurringOrder(recurringOrderId:$id){${RECURRING_FIELDS}}}`, { id: recurringOrderId });
  }
  /** Adiar / pular o próximo ciclo. */
  skipNextCycle(recurringOrderId: string) {
    return this.gql(`mutation($id:String!){customerSkipNextRecurringOrderCycle(recurringOrderId:$id){${RECURRING_FIELDS}}}`, { id: recurringOrderId });
  }
  /** Cancelar assinatura. */
  cancel(recurringOrderId: string) {
    return this.gql(`mutation($id:String!){customerCancelRecurringOrder(recurringOrderId:$id){${RECURRING_FIELDS}}}`, { id: recurringOrderId });
  }
  /** Trocar itens/quantidade. */
  updateItems(recurringOrderId: string, items: Array<{ productId: string; variantId: string; quantity: number; skipNextCycle?: boolean }>) {
    const q = `mutation($i:UpdateRecurringOrderItemsInput){customerUpdateRecurringOrderItems(input:$i){${RECURRING_FIELDS}}}`;
    return this.gql(q, { i: { recurringOrderId, recurringOrderItems: items.map((x) => ({ ...x, skipNextCycle: x.skipNextCycle ?? false })) } });
  }
  /** Trocar cartão da assinatura. */
  updateCard(recurringOrderId: string, card: { holderName: string; cardNumber: string; expirationMonth: string; expirationYear: string; securityCode: string }) {
    const q = `mutation($i:UpdateRecurringOrderCreditCardInput!){customerUpdateRecurringOrderCreditCard(input:$i){${RECURRING_FIELDS}}}`;
    return this.gql(q, { i: { recurringOrderId, creditCardData: card } });
  }
  /** Trocar endereço de entrega da assinatura. */
  updateAddress(recurringOrderId: string, shippingAddress: AddressInput) {
    const q = `mutation($i:UpdateRecurringOrderShippingAddressInput!){customerUpdateRecurringOrderShippingAddress(input:$i){
      _id postal address1 number neighborhood city region fullName }}`;
    return this.gql(q, { i: { recurringOrderId, shippingAddress: { country: "BR", ...shippingAddress } } });
  }

  // ------------------------------------------------------------------ endereços
  /**
   * Busca endereços por ID. ⚠️ `customerAddressBooks` exige ao menos 1 id (não aceita lista vazia).
   * Para a LISTA COMPLETA do cliente, use `me().addressBooks` (vem em currentCustomerAccount).
   */
  async addressBooks(ids: string[]): Promise<any[]> {
    if (!ids?.length) throw new UnboxError("customerAddressBooks exige ao menos 1 id — use me().addressBooks para a lista completa");
    const q = `query($i:AddressBooksInput!){ customerAddressBooks(input:$i){
      _id alias fullName postal address1 address2 number neighborhood city region taxPayerId phone
      isShippingDefault isBillingDefault }}`;
    const d = await this.gql<{ customerAddressBooks: any[] }>(q, { i: { addressBooksIds: ids } });
    return d.customerAddressBooks;
  }

  /**
   * Cria/atualiza um endereço do cliente (upsert). O input é PLANO (`UpsertAddressBookInput`):
   * os campos do endereço vão no primeiro nível, sem o envelope `addressBook`.
   *
   * ⚠️ O input não declara `_id` nem `trackByMobile`: quem chama pode mandar, e os dois são
   * descartados aqui em vez de derrubar a mutação inteira com "unknown field". Qual endereço
   * atualizar é o backend que resolve — mandar o `_id` nunca foi o que fazia o update.
   */
  async upsertAddress(address: AddressInput & { _id?: string; alias?: string; addressName?: string; isShippingDefault?: boolean; isBillingDefault?: boolean }): Promise<any> {
    const q = `mutation($i:UpsertAddressBookInput!){ upsertCustomerAddressBook(input:$i){
      _id alias fullName postal address1 number neighborhood city region isShippingDefault isBillingDefault }}`;
    const { _id, trackByMobile, ...campos } = address;
    void _id; void trackByMobile;
    const d = await this.gql<{ upsertCustomerAddressBook: any }>(q, { i: { country: "BR", ...campos } });
    return d.upsertCustomerAddressBook;
  }

  /** Remove endereços do address book pelos ids. */
  async deleteAddresses(ids: string[]): Promise<any> {
    const q = `mutation($i:DeleteCustomerAddressBooksInput!){ deleteCustomerAddressBooks(input:$i){ _id } }`;
    const d = await this.gql<{ deleteCustomerAddressBooks: any }>(q, { i: { addressBooksIds: ids } });
    return d.deleteCustomerAddressBooks;
  }
}

/**
 * Rótulos PT-BR para Order.status (workaround do displayStatus quebrado na Unbox).
 * Valores conforme OrderStatusEnum do schema: PENDING, PROCESSING, COMPLETED, CANCELED, FAILED, REFUNDED.
 */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: "Aguardando pagamento",
  PROCESSING: "Em processamento",
  COMPLETED: "Concluído",
  CANCELED: "Cancelado",
  FAILED: "Falhou",
  REFUNDED: "Reembolsado",
};
export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status;
}

/** Rótulos PT-BR para PaymentStatusEnum. */
export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  CREATED: "Criado",
  PENDING: "Aguardando pagamento",
  AUTHORIZED: "Autorizado",
  CAPTURED: "Capturado",
  PAID: "Pago",
  CANCELED: "Cancelado",
  REFUNDED: "Reembolsado",
  EXPIRED: "Expirado",
  CHARGED_BACK: "Estornado (chargeback)",
};
export function paymentStatusLabel(status: string): string {
  return PAYMENT_STATUS_LABELS[status] ?? status;
}

// ── STATUS QUE CHEGAM AO CLIENTE ─────────────────────────────────────────────────────────────
// Valor cru não é texto para cliente ("SHIPPING · new" chegou a aparecer na página do pedido). Todo
// mapa abaixo devolve undefined para o que ainda não conhece, e quem exibe cai no valor original: um
// status novo da API aparece cru, mas aparece. Sumir com ele esconderia justamente a novidade.

/** Status do GRUPO de entrega (`OrderFulfillmentGroup.status`). É String livre no schema: os valores
 *  vêm do workflow do backend, com e sem o prefixo `coreOrderWorkflow/`. */
export const FULFILLMENT_STATUS_LABELS: Record<string, string> = {
  new: "Preparando o pedido",
  created: "Preparando o pedido",
  processing: "Em separação",
  picked: "Separado",
  packed: "Embalado",
  labeled: "Etiqueta emitida",
  shipped: "Enviado",
  completed: "Entregue",
  canceled: "Cancelado",
};
export function fulfillmentStatusLabel(status?: string | null): string | undefined {
  if (!status) return undefined;
  const limpo = status.replace(/^coreOrderWorkflow\//, "").trim().toLowerCase();
  return FULFILLMENT_STATUS_LABELS[limpo];
}

/** `FulfillmentType` do schema: SHIPPING e NONE. */
export const FULFILLMENT_TYPE_LABELS: Record<string, string> = {
  SHIPPING: "Entrega",
  NONE: "Sem entrega",
};
export function fulfillmentTypeLabel(type?: string | null): string | undefined {
  return type ? FULFILLMENT_TYPE_LABELS[type] : undefined;
}

/** `TrackingEventStatusEnum`: os eventos do histórico de rastreio. */
export const TRACKING_STATUS_LABELS: Record<string, string> = {
  POSTED: "Postado",
  IN_TRANSIT: "Em trânsito",
  NOT_DELIVERED: "Não entregue",
  DELIVERED: "Entregue",
  AWAITING_WITHDRAWAL: "Aguardando retirada",
  PENDING: "Pendente",
  BOUND: "A caminho",
  LATE: "Atrasado",
  NOT_POSTED: "Ainda não postado",
  SUSPENDED_DELIVERY: "Entrega suspensa",
};
export function trackingStatusLabel(status?: string | null): string | undefined {
  return status ? TRACKING_STATUS_LABELS[status] : undefined;
}

/**
 * SELO DO PEDIDO: o status do PAGAMENTO, não o do pedido. "Pedido pago" diz ao cliente o que ele quer
 * saber; "Em processamento" não diz. Cobre os dois enums: `CustomerPaymentStatusEnum` (PAID, PENDING,
 * CANCELED, na conta do cliente) e `PaymentStatusEnum` (o do pedido lido com o token da loja).
 */
export const PAYMENT_SEAL_LABELS: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "muted" }> = {
  PAID: { label: "Pedido pago", tone: "ok" },
  CAPTURED: { label: "Pedido pago", tone: "ok" },
  AUTHORIZED: { label: "Pagamento autorizado", tone: "ok" },
  PENDING: { label: "Aguardando pagamento", tone: "warn" },
  CREATED: { label: "Aguardando pagamento", tone: "warn" },
  CANCELED: { label: "Pagamento cancelado", tone: "bad" },
  EXPIRED: { label: "Pagamento expirado", tone: "bad" },
  FAILED: { label: "Pagamento recusado", tone: "bad" },
  REFUNDED: { label: "Reembolsado", tone: "muted" },
  CHARGED_BACK: { label: "Estornado", tone: "muted" },
};
export function paymentSeal(status?: string | null) {
  return status ? PAYMENT_SEAL_LABELS[status] : undefined;
}

/** Rótulos PT-BR para RecurringOrderStatusEnum (assinatura). */
export const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Ativa",
  PAUSED: "Pausada",
  CANCELED: "Cancelada",
  ERROR: "Com erro",
};
export function subscriptionStatusLabel(status: string): string {
  return SUBSCRIPTION_STATUS_LABELS[status] ?? status;
}

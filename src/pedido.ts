// Seleções e degradação do PEDIDO, compartilhadas pelo cliente de loja (client.ts, pedido de quem
// comprou sem conta) e pelo cliente logado (customer.ts). Moram fora dos dois porque o cliente logado
// já importa o de loja: se o de loja importasse o logado, fecharia um ciclo de módulos, e constante
// dentro de ciclo pode ser lida antes de existir.

/** Quebra do total do pedido (Subtotal, Frete, Descontos). Pedido pelo `amount`: o `displayAmount`
 *  no contexto de cliente já veio "R$NaN,undefined", e quem exibe formata a partir do número. */
export const DETAILED_SUMMARY = " itemTotal{amount} fulfillmentTotal{amount} discountTotal{amount}";

/** Método de envio escolhido e rastreio do grupo de entrega. */
export const SHIPPING_AND_TRACKING = `selectedFulfillmentOption{ price{amount} fulfillmentMethod{carrier label daysToDeliver} }
          tracking{ code url event{ value{status description createdAt} history{ value{status description createdAt} createdAt } } }`;

/** Recusa que é da SESSÃO (token vencido ou inválido), e não da consulta: essa não se contorna
 *  trocando a seleção, e quem chama precisa mandar a pessoa para o login. */
export function isSessionError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNAUTHENTICATED|unauthori[sz]ed|not authenticated|jwt expired|token expired/i.test(msg);
}

/** Tenta a seleção RICA e cai para a ENXUTA quando a API recusar, registrando o motivo.
 *
 *  Este backend derruba a resposta inteira quando um único campo incomoda (non-null que volta null,
 *  resolver que lança). Então todo campo além do essencial é risco, e o risco tem de custar só o
 *  adorno: perder o histórico de rastreio é aceitável, o cliente ficar sem ver o pedido que pagou
 *  não é. Erro de sessão não degrada, sobe. */
export async function withLeanSelection<T>(rotulo: string, rica: () => Promise<T>, enxuta: () => Promise<T>): Promise<T> {
  try {
    return await rica();
  } catch (e) {
    if (isSessionError(e)) throw e;
    console.error(JSON.stringify({
      tag: "[unbox]",
      aviso: `${rotulo}: a seleção completa foi recusada, repetindo com a enxuta`,
      erro: (e instanceof Error ? e.message : String(e)).slice(0, 300),
      quando: new Date().toISOString(),
    }));
    return enxuta();
  }
}

/** Imagem do item do pedido. `OrderItem` guarda `imageURLs: ImageSizes` (um objeto de tamanhos),
 *  que é o que a conta hospedada da Unbox seleciona. A loja lê `thumbnail`: a normalização abaixo
 *  mantém esse contrato. */
export const ITEM_IMAGES = "imageURLs{thumbnail small medium large original}";

export function normalizeThumbnails<T>(order: T): T {
  for (const g of (order as any)?.fulfillmentGroups ?? []) {
    for (const n of g?.items?.nodes ?? []) {
      const img = n?.imageURLs;
      if (n && n.thumbnail === undefined) n.thumbnail = img?.thumbnail ?? img?.small ?? img?.medium ?? img?.original ?? "";
    }
  }
  return order;
}

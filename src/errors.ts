// errors.ts — tradução de erros/eventos da Unbox em FEEDBACK ao cliente final (PT-BR).
//
// A Unbox sinaliza problemas de 3 formas:
//   1) erro LANÇADO no GraphQL (json.errors[].message = um CÓDIGO, ex. DISCOUNT_CODE_NOT_FOUND_ERROR)
//   2) campos de FALHA no payload (min/maxOrderQuantityFailures). Obs.: incorrectPriceFailures
//      NÃO é confiável — o servidor sobrescreve o preço e o campo vem vazio (validado ao vivo).
//   3) cartEvents[] (eventos informativos: brinde adicionado, cupom removido, etc.)
//
// Use friendlyError() no catch das chamadas e cartEventLabel() ao renderizar o carrinho.

import { UnboxError } from "./client.js";

/** Código de erro (json.errors[].message) → mensagem amigável ao cliente. */
export const ERROR_MESSAGES: Record<string, string> = {
  // ---- carrinho / itens ----
  MISSING_ITEMS_ERROR: "Um ou mais produtos não estão mais disponíveis.",
  ITEM_ERROR: "Há um problema com um item do seu carrinho.",
  CREATE_CART_ERROR: "Não foi possível criar o carrinho. Tente novamente.",
  OUT_OF_STOCK: "Produto esgotado.",
  // ---- cupom / desconto ----
  DISCOUNT_CODE_NOT_FOUND_ERROR: "Cupom inválido ou expirado.",
  DISCOUNT_AVAILABLE_FOR_NON_RECURRING_PRODUCTS_ONLY_ERROR:
    "Este cupom não vale para itens de assinatura. Troque a assinatura por compra única para usá-lo.",
  DISCOUNT_AVAILABLE_FOR_RECURRING_PRODUCTS_ONLY_ERROR:
    "Este cupom só vale para itens de assinatura.",
  DISCOUNT_NOT_APPLICABLE_ERROR: "Este cupom não se aplica aos itens do seu carrinho.",
  DISCOUNT_EXPIRED_ERROR: "Cupom expirado.",
  DISCOUNT_USAGE_LIMIT_REACHED_ERROR: "Este cupom atingiu o limite de uso.",
  DISCOUNT_MINIMUM_ORDER_NOT_MET_ERROR: "Seu pedido ainda não atingiu o valor mínimo para este cupom.",
  DISCOUNT_ALREADY_APPLIED_ERROR: "Este cupom já está aplicado ao carrinho.",
  // ---- endereço / frete ----
  ADDRESS_BOOK_ERROR: "Endereço inválido. Confira os dados.",
  NO_FULFILLMENT_OPTIONS: "Não há opções de entrega para este CEP.",
  // ---- pagamento (recusas do processador / UnboxPay-Zoop) ----
  INSUFFICIENT_FUNDS_ERROR: "Pagamento recusado: saldo/limite insuficiente.",
  PAYMENT_ERROR: "Não foi possível processar o pagamento. Tente outro método.",
  PLACE_ORDER_ERROR: "Não foi possível concluir o pedido. Tente novamente.",
  CARD_DECLINED_ERROR: "Cartão recusado. Verifique os dados ou use outro cartão.",
  FULFILLMENT_GROUP_AND_CART_ITEMS_DO_NOT_MATCH_ERROR: "Há um item promocional inválido no pedido. Atualize o carrinho e tente novamente.",
  // ---- conta do cliente ----
  CUSTOMER_ACCOUNT_ERROR: "Não foi possível acessar sua conta.",
  INVALID_CREDENTIALS_ERROR: "Código ou credenciais inválidos.",
  UNBOX_PAY_CUSTOMER_ERROR: "Falha no cadastro de pagamento. Tente novamente.",
  // ---- infra / genéricos ----
  FORBIDDEN_ERROR: "Ação não autorizada. Recarregue a página e tente novamente.",
  VALIDATION_ERROR: "Alguns dados são inválidos. Revise o formulário.",
  UNEXPECTED_ERROR: "Algo deu errado. Tente novamente em instantes.",
  INTERNAL_SERVER_ERROR: "Algo deu errado. Tente novamente em instantes.",
};

/** O login sem senha (OTP) NÃO responde no formato dos outros erros: em vez de um CÓDIGO_ERRO,
 *  devolve um corpo OAuth (`{"error":"invalid_grant","error_description":"Wrong email or
 *  verification code."}`). Sem este dicionário caía no fallback, e quem digitou um código
 *  expirado lia "Algo deu errado", redigitava o MESMO código e desistia (caso real). */
const OAUTH_ERRORS: [RegExp, string][] = [
  [/expired_token|code has expired|c[oó]digo expirad/i, "Este código expirou. Peça um novo."],
  [/invalid_grant|wrong email or verification code/i, "Código incorreto ou expirado. Peça um novo código."],
  [/too many|rate.?limit/i, "Muitas tentativas. Aguarde um instante e tente de novo."],
  [/invalid_client|unauthorized_client/i, "Não foi possível validar o acesso. Recarregue a página e tente de novo."],
];

const FALLBACK = "Algo deu errado. Tente novamente.";

/**
 * Converte um erro do SDK/Unbox em mensagem amigável ao cliente.
 * Casa por código exato e por substring (a mensagem do servidor costuma SER o código).
 */
export function friendlyError(err: unknown): string {
  let raw: string;
  if (err instanceof UnboxError) raw = err.errors?.[0]?.message ?? err.message;
  else if (err instanceof Error) raw = err.message;
  else if (err && typeof err === "object") {
    const o = err as any;
    raw = o.errors?.[0]?.message ?? o.message ?? String(err);
  } else raw = String(err);
  // O corpo OAuth do login por código não casa com nenhum CÓDIGO_ERRO: testar antes do dicionário.
  for (const [rx, msg] of OAUTH_ERRORS) if (rx.test(raw)) return msg;
  if (ERROR_MESSAGES[raw]) return ERROR_MESSAGES[raw];
  for (const code of Object.keys(ERROR_MESSAGES)) {
    if (raw.includes(code)) return ERROR_MESSAGES[code];
  }
  // validação de variável GraphQL (ex.: campo obrigatório ausente)
  if (/required type|got invalid value|Expected/.test(raw)) return ERROR_MESSAGES.VALIDATION_ERROR;
  return FALLBACK;
}

/** CartEventEnum (cart.cartEvents[].type) → mensagem informativa ao cliente. */
export const CART_EVENT_LABELS: Record<string, string> = {
  SALE_FREE_ITEM_ADDED: "🎁 Você ganhou um brinde!",
  SALE_FREE_ITEM_CHANGED: "Seu brinde foi atualizado.",
  SALE_FREE_ITEM_REMOVED: "O brinde foi removido (condição da promoção não atendida).",
  DISCOUNT_CODE_REMOVED: "O cupom foi removido do carrinho.",
  DISCOUNT_CODE_RECOVERED: "Seu cupom foi reaplicado.",
};
export function cartEventLabel(type: string): string {
  return CART_EVENT_LABELS[type] ?? type;
}

/** Nome técnico do campo de endereço, do jeito que a pessoa vê no formulário. */
export const ADDRESS_FIELD: Record<string, string> = {
  fullName: "nome completo", address1: "endereço", number: "número", neighborhood: "bairro",
  city: "cidade", region: "estado (UF)", postal: "CEP", phone: "telefone",
  taxPayerId: "CPF/CNPJ", country: "país", address2: "complemento",
};

/**
 * A Unbox diz QUAL campo do endereço recusou, em `invalidAddressFields` (às vezes na raiz do
 * erro, às vezes em `extensions`). Sem ler isso, a pessoa lê "endereço inválido", não sabe o que
 * corrigir e desiste (caso real em produção).
 *
 * Devolve null quando o erro não é de endereço — quem chama cai no `friendlyError`.
 */
export function invalidAddressMessage(err: unknown): string | null {
  if (!(err instanceof UnboxError)) return null;
  for (const e of err.errors ?? []) {
    const campos = (e as any)?.extensions?.invalidAddressFields ?? (e as any)?.invalidAddressFields;
    const nomes = Object.keys(campos ?? {}).map((k) => ADDRESS_FIELD[k] ?? k);
    if (!nomes.length) continue;
    const lista = nomes.length === 1 ? nomes[0] : `${nomes.slice(0, -1).join(", ")} e ${nomes[nomes.length - 1]}`;
    return `Confira ${nomes.length === 1 ? "o campo" : "os campos"} ${lista} e tente de novo.`;
  }
  return null;
}

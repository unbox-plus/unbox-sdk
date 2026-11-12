// Checagem do `setCartRecurringFrequency` — npm run build && node tools/check-cart-frequency.mjs
// Sem framework: o `gql` da instância é trocado por um falso que captura query e variáveis.
// Fica fora do `files` do package.json.
import assert from "node:assert/strict";
import { UnboxClient, UnboxError } from "../dist/index.js";

const client = new UnboxClient({ partnerApiKey: "k" });
const payload = { cart: { _id: "C1", recurringItemsFrequencyId: "F1" }, cartEvents: [] };
let chamadas = [];
client.gql = async (q, v) => { chamadas.push({ q, v }); return { updateCart: payload }; };

// grava: input só com os três campos, nada de paymentMethod/numberOfInstallments
const r = await client.setCartRecurringFrequency("C1", "T1", "F1");
assert.equal(r, payload);
assert.equal(chamadas.length, 1);
assert.match(chamadas[0].q, /UpdateCartInput!/);
assert.match(chamadas[0].q, /updateCart\(input:\$i\)/);
assert.deepEqual(chamadas[0].v, { i: { cartId: "C1", cartToken: "T1", recurringItemsFrequencyId: "F1" } });
// o JSON que sai para a rede também só tem as três chaves
assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(chamadas[0].v)).i).sort(), ["cartId", "cartToken", "recurringItemsFrequencyId"]);

// limpa: null vai como null (é o que o servidor entende como "zerar"), sem sumir no JSON
chamadas = [];
await client.setCartRecurringFrequency("C1", "T1", null);
assert.equal(JSON.parse(JSON.stringify(chamadas[0].v)).i.recurringItemsFrequencyId, null);

// vazio e só espaços: lança UnboxError sem chamar a rede
chamadas = [];
for (const ruim of ["", "   ", undefined]) {
  await assert.rejects(client.setCartRecurringFrequency("C1", "T1", ruim), UnboxError);
}
assert.equal(chamadas.length, 0);

console.log("ok setCartRecurringFrequency: input só com a frequência, null limpa, vazio lança sem rede");

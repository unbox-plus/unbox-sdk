// Checagem do payload do `updateItems` — npm run build && node tools/check-update-items.mjs
// Sem framework: um `loja` falso captura as variáveis do gql. Fica fora do `files` do package.json.
import assert from "node:assert/strict";
import { UnboxCustomerClient } from "../dist/index.js";

let vars;
const loja = { gql: async (_q, v) => { vars = v; return {}; } };
const customer = new UnboxCustomerClient({ customerToken: "t", loja });

await customer.updateItems("RO1", [
  { productId: "p1", variantId: "v1", quantity: 2 },
  { productId: "x", variantId: "y", quantity: 1, productKitId: "K1", productKitItemsConfigurations: [{ productId: "a", productVariantId: "va", quantity: 2 }] },
  { productKitId: "K2", quantity: 1, skipNextCycle: true, productKitItemsConfigurations: [] },
]);

const [comum, kit, kit2] = vars.i.recurringOrderItems;
assert.deepEqual(comum, { productId: "p1", variantId: "v1", quantity: 2, skipNextCycle: false });
assert.deepEqual(Object.keys(kit).sort(), ["productKitId", "productKitItemsConfigurations", "quantity", "skipNextCycle"]);
assert.ok(!("productId" in kit2) && !("variantId" in kit2) && kit2.skipNextCycle === true);
console.log("ok updateItems: kit sem productId/variantId, produto comum intacto");

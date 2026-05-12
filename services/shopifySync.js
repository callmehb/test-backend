'use strict';

const Product = require('../models/Product');
const ShopifySyncState = require('../models/ShopifySyncState');

const STORE = (process.env.STORE || '').trim();
const SHOPIFY_GQL_URL = `https://${STORE}/admin/api/2026-01/graphql.json`;
const TOKEN_URL = `https://${STORE}/admin/oauth/access_token`;
const BATCH_SIZE = 100;

// ── Token cache ───────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0;

async function fetchAccessToken() {
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: (process.env.grant_type || '').trim(),
            client_id: (process.env.client_id || '').trim(),
            client_secret: (process.env.client_secret || '').trim()
        })
    });
    if (!res.ok) throw new Error(`Token fetch failed HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (!data.access_token) throw new Error(`Token response missing access_token: ${JSON.stringify(data)}`);
    cachedToken = data.access_token;
    // Default to 24h if expires_in not provided; refresh 60s before expiry
    const expiresIn = data.expires_in ?? 86400;
    tokenExpiresAt = Date.now() + (expiresIn - 60) * 1000;
    console.log('[SHOPIFY SYNC] Access token refreshed.');
    return cachedToken;
}

async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
    return fetchAccessToken();
}

// ── GraphQL helper ────────────────────────────────────────────────────────────
async function shopifyGraphQL(query, variables = {}, isRetry = false) {
    const token = await getAccessToken();
    const res = await fetch(SHOPIFY_GQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables })
    });
    if (res.status === 401 && !isRetry) {
        // Force token refresh and retry once
        cachedToken = null;
        tokenExpiresAt = 0;
        return shopifyGraphQL(query, variables, true);
    }
    if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    if (json.errors) throw new Error(`Shopify GQL errors: ${JSON.stringify(json.errors)}`);
    return json;
}

// ── Shopify ID lookup ─────────────────────────────────────────────────────────
async function fetchShopifyIds(sku) {
    const query = `
        query($q: String!) {
            productVariants(first: 1, query: $q) {
                edges {
                    node {
                        id
                        inventoryItem {
                            id
                            inventoryLevels(first: 1) {
                                edges { node { location { id } } }
                            }
                        }
                    }
                }
            }
        }
    `;
    const json = await shopifyGraphQL(query, { q: `sku:${sku}` });
    const edges = json.data.productVariants.edges;
    if (!edges.length) return null;
    const node = edges[0].node;
    const item = node.inventoryItem;
    const levelEdges = item.inventoryLevels.edges;
    if (!levelEdges.length) return null;
    return {
        variantId: node.id,
        inventoryItemId: item.id,
        locationId: levelEdges[0].node.location.id
    };
}

// ── Mutations ─────────────────────────────────────────────────────────────────
async function sendInventoryBatch(items) {
    const mutation = `
        mutation($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) {
                userErrors { field message }
            }
        }
    `;
    const json = await shopifyGraphQL(mutation, {
        input: {
            name: 'available',
            reason: 'correction',
            ignoreCompareQuantity: true,
            quantities: items.map(i => ({
                inventoryItemId: i.inventoryItemId,
                locationId: i.locationId,
                quantity: i.quantity
            }))
        }
    });
    const errors = json.data.inventorySetQuantities.userErrors;
    if (errors.length) throw new Error(`inventorySetQuantities userErrors: ${JSON.stringify(errors)}`);
}

function esc(val) {
    return (val ?? '').toString().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function sendVariantBatch(items) {
    const body = items.map((item, i) =>
        `v${i}: productVariantUpdate(input: { id: "${esc(item.variantId)}", price: "${item.price.toFixed(2)}", barcode: "${esc(item.barcode)}" }) { userErrors { field message } }`
    ).join('\n');
    const json = await shopifyGraphQL(`mutation { ${body} }`);
    const allErrors = items.flatMap((_, i) => json.data[`v${i}`]?.userErrors ?? []);
    if (allErrors.length) throw new Error(`productVariantUpdate userErrors: ${JSON.stringify(allErrors)}`);
}

async function sendCostBatch(items) {
    const body = items.map((item, i) =>
        `c${i}: inventoryItemUpdate(id: "${esc(item.inventoryItemId)}", input: { cost: "${item.cost.toFixed(2)}" }) { userErrors { field message } }`
    ).join('\n');
    const json = await shopifyGraphQL(`mutation { ${body} }`);
    const allErrors = items.flatMap((_, i) => json.data[`c${i}`]?.userErrors ?? []);
    if (allErrors.length) throw new Error(`inventoryItemUpdate userErrors: ${JSON.stringify(allErrors)}`);
}

// ── Main sync ─────────────────────────────────────────────────────────────────
async function runSync() {
    console.log('[SHOPIFY SYNC] Starting sync run at', new Date().toISOString());
    try {
        const products = await Product.find(
            { sku: { $exists: true, $ne: '' } },
            { _id: 1, sku: 1, quantity: 1, trackQuantity: 1, price: 1, cost: 1, barcode: 1 }
        ).lean();

        if (!products.length) {
            console.log('[SHOPIFY SYNC] No products with SKUs. Skipping.');
            return;
        }

        const productMap = new Map(products.map(p => [p._id.toString(), p]));

        const syncStates = await ShopifySyncState.find(
            { productId: { $in: products.map(p => p._id) } }
        ).lean();
        const stateMap = new Map(syncStates.map(s => [s.productId.toString(), s]));

        const inventoryItems = [];
        const variantItems = [];
        const costItems = [];
        const missingSkuUpserts = [];
        const resolvedIds = new Map(); // pid -> { variantId, inventoryItemId, locationId }

        for (const product of products) {
            const pid = product._id.toString();
            let state = stateMap.get(pid);

            // Reset cached Shopify IDs if SKU changed
            if (state && state.sku !== product.sku) {
                state = { ...state, variantId: null, inventoryItemId: null, locationId: null, shopifySkuMissing: false };
            }

            if (state?.shopifySkuMissing) continue;

            const currentQty = product.quantity ?? 0;
            const currentPrice = product.price ?? 0;
            const currentCost = product.cost ?? 0;
            const currentBarcode = product.barcode ?? '';

            const qtyChanged = product.trackQuantity && (state == null || currentQty !== state.lastSyncedQuantity);
            const priceChanged = state == null || currentPrice !== state.lastSyncedPrice;
            const costChanged = state == null || currentCost !== state.lastSyncedCost;
            const barcodeChanged = state == null || currentBarcode !== (state.lastSyncedBarcode ?? '');

            if (!qtyChanged && !priceChanged && !costChanged && !barcodeChanged) continue;

            // Resolve Shopify IDs — use cache or fetch
            let { variantId, inventoryItemId, locationId } = state || {};
            if (!variantId || !inventoryItemId || !locationId) {
                try {
                    const ids = await fetchShopifyIds(product.sku);
                    if (!ids) {
                        missingSkuUpserts.push({
                            updateOne: {
                                filter: { productId: product._id },
                                update: { $set: { productId: product._id, sku: product.sku, shopifySkuMissing: true } },
                                upsert: true
                            }
                        });
                        continue;
                    }
                    variantId = ids.variantId;
                    inventoryItemId = ids.inventoryItemId;
                    locationId = ids.locationId;
                } catch (err) {
                    console.error(`[SHOPIFY SYNC] Failed to fetch Shopify IDs for SKU "${product.sku}":`, err.message);
                    continue;
                }
            }

            resolvedIds.set(pid, { variantId, inventoryItemId, locationId });

            if (qtyChanged)
                inventoryItems.push({ productId: product._id, quantity: currentQty, inventoryItemId, locationId });
            if (priceChanged || barcodeChanged)
                variantItems.push({ productId: product._id, price: currentPrice, barcode: currentBarcode, variantId });
            if (costChanged)
                costItems.push({ productId: product._id, cost: currentCost, inventoryItemId });
        }

        if (missingSkuUpserts.length) {
            await ShopifySyncState.bulkWrite(missingSkuUpserts).catch(e =>
                console.error('[SHOPIFY SYNC] Failed to write missing SKU markers:', e.message)
            );
        }

        if (!inventoryItems.length && !variantItems.length && !costItems.length) {
            console.log('[SHOPIFY SYNC] No changes to push.');
            return;
        }

        const now = new Date();
        const successMap = new Map(); // pid -> { quantity?, price?, barcode?, cost? }

        for (let i = 0; i < inventoryItems.length; i += BATCH_SIZE) {
            const batch = inventoryItems.slice(i, i + BATCH_SIZE);
            try {
                await sendInventoryBatch(batch);
                for (const item of batch) {
                    const pid = item.productId.toString();
                    if (!successMap.has(pid)) successMap.set(pid, {});
                    successMap.get(pid).quantity = item.quantity;
                }
                console.log(`[SHOPIFY SYNC] Pushed inventory for ${batch.length} item(s).`);
            } catch (err) {
                console.error('[SHOPIFY SYNC] Inventory batch failed:', err.message);
            }
        }

        for (let i = 0; i < variantItems.length; i += BATCH_SIZE) {
            const batch = variantItems.slice(i, i + BATCH_SIZE);
            try {
                await sendVariantBatch(batch);
                for (const item of batch) {
                    const pid = item.productId.toString();
                    if (!successMap.has(pid)) successMap.set(pid, {});
                    Object.assign(successMap.get(pid), { price: item.price, barcode: item.barcode });
                }
                console.log(`[SHOPIFY SYNC] Pushed price/barcode for ${batch.length} item(s).`);
            } catch (err) {
                console.error('[SHOPIFY SYNC] Variant batch failed:', err.message);
            }
        }

        for (let i = 0; i < costItems.length; i += BATCH_SIZE) {
            const batch = costItems.slice(i, i + BATCH_SIZE);
            try {
                await sendCostBatch(batch);
                for (const item of batch) {
                    const pid = item.productId.toString();
                    if (!successMap.has(pid)) successMap.set(pid, {});
                    successMap.get(pid).cost = item.cost;
                }
                console.log(`[SHOPIFY SYNC] Pushed cost for ${batch.length} item(s).`);
            } catch (err) {
                console.error('[SHOPIFY SYNC] Cost batch failed:', err.message);
            }
        }

        const stateUpserts = [];
        for (const [pid, updates] of successMap) {
            const product = productMap.get(pid);
            const ids = resolvedIds.get(pid);
            const setFields = {
                productId: product._id,
                sku: product.sku,
                variantId: ids.variantId,
                inventoryItemId: ids.inventoryItemId,
                locationId: ids.locationId,
                shopifySkuMissing: false,
                lastSyncedAt: now
            };
            if ('quantity' in updates) setFields.lastSyncedQuantity = updates.quantity;
            if ('price' in updates) setFields.lastSyncedPrice = updates.price;
            if ('barcode' in updates) setFields.lastSyncedBarcode = updates.barcode;
            if ('cost' in updates) setFields.lastSyncedCost = updates.cost;

            stateUpserts.push({
                updateOne: {
                    filter: { productId: product._id },
                    update: { $set: setFields },
                    upsert: true
                }
            });
        }

        if (stateUpserts.length) {
            await ShopifySyncState.bulkWrite(stateUpserts).catch(e =>
                console.error('[SHOPIFY SYNC] Failed to write sync state:', e.message)
            );
        }

        console.log(`[SHOPIFY SYNC] Sync run complete. ${successMap.size} product(s) updated.`);
    } catch (err) {
        console.error('[SHOPIFY SYNC] Unexpected error in runSync:', err.message);
    }
}

module.exports = { runSync };

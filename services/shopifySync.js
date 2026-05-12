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
    const params = new URLSearchParams({
        grant_type: (process.env.grant_type || '').trim(),
        client_id: (process.env.client_id || '').trim(),
        client_secret: (process.env.client_secret || '').trim()
    });
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });
    if (!res.ok) throw new Error(`Token fetch failed HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (!data.access_token) throw new Error(`Token response missing access_token: ${JSON.stringify(data)}`);
    cachedToken = data.access_token;
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
                        product { id }
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
        shopifyProductId: node.product.id,
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

// Sends price, barcode, and cost for a group of variants belonging to ONE Shopify product
async function sendVariantUpdate(shopifyProductId, variants) {
    const mutation = `
        mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                userErrors { field message }
            }
        }
    `;
    const json = await shopifyGraphQL(mutation, {
        productId: shopifyProductId,
        variants: variants.map(v => ({
            id: v.variantId,
            price: v.price.toFixed(2),
            barcode: v.barcode ?? '',
            inventoryItem: { cost: v.cost.toFixed(2) }
        }))
    });
    const errors = json.data.productVariantsBulkUpdate.userErrors;
    if (errors.length) throw new Error(`productVariantsBulkUpdate userErrors: ${JSON.stringify(errors)}`);
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
        const variantItems = [];   // price + barcode + cost together
        const missingSkuUpserts = [];
        const resolvedIds = new Map();

        for (const product of products) {
            const pid = product._id.toString();
            let state = stateMap.get(pid);

            if (state && state.sku !== product.sku) {
                state = { ...state, shopifyProductId: null, variantId: null, inventoryItemId: null, locationId: null, shopifySkuMissing: false };
            }

            if (state?.shopifySkuMissing) continue;

            const currentQty = product.quantity ?? 0;
            const currentPrice = product.price ?? 0;
            const currentCost = product.cost ?? 0;
            const currentBarcode = product.barcode ?? '';

            const qtyChanged = product.trackQuantity && (state == null || currentQty !== state.lastSyncedQuantity);
            const variantChanged = state == null
                || currentPrice !== state.lastSyncedPrice
                || currentCost !== state.lastSyncedCost
                || currentBarcode !== (state.lastSyncedBarcode ?? '');

            if (!qtyChanged && !variantChanged) continue;

            let { shopifyProductId, variantId, inventoryItemId, locationId } = state || {};
            if (!shopifyProductId || !variantId || !inventoryItemId || !locationId) {
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
                    ({ shopifyProductId, variantId, inventoryItemId, locationId } = ids);
                } catch (err) {
                    console.error(`[SHOPIFY SYNC] Failed to fetch Shopify IDs for SKU "${product.sku}":`, err.message);
                    continue;
                }
            }

            resolvedIds.set(pid, { shopifyProductId, variantId, inventoryItemId, locationId });

            if (qtyChanged)
                inventoryItems.push({ productId: product._id, quantity: currentQty, inventoryItemId, locationId });

            if (variantChanged)
                variantItems.push({ productId: product._id, shopifyProductId, variantId, price: currentPrice, cost: currentCost, barcode: currentBarcode });
        }

        if (missingSkuUpserts.length) {
            await ShopifySyncState.bulkWrite(missingSkuUpserts).catch(e =>
                console.error('[SHOPIFY SYNC] Failed to write missing SKU markers:', e.message)
            );
        }

        if (!inventoryItems.length && !variantItems.length) {
            console.log('[SHOPIFY SYNC] No changes to push.');
            return;
        }

        const now = new Date();
        const successMap = new Map();

        // Inventory (quantity) batches
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

        // Variant (price/barcode/cost) — group by shopifyProductId, send one mutation per product
        const byProduct = new Map();
        for (const item of variantItems) {
            if (!byProduct.has(item.shopifyProductId)) byProduct.set(item.shopifyProductId, []);
            byProduct.get(item.shopifyProductId).push(item);
        }

        for (const [shopifyProductId, variants] of byProduct) {
            try {
                await sendVariantUpdate(shopifyProductId, variants);
                for (const item of variants) {
                    const pid = item.productId.toString();
                    if (!successMap.has(pid)) successMap.set(pid, {});
                    Object.assign(successMap.get(pid), { price: item.price, cost: item.cost, barcode: item.barcode });
                }
                console.log(`[SHOPIFY SYNC] Pushed price/barcode/cost for ${variants.length} variant(s) of product ${shopifyProductId}.`);
            } catch (err) {
                console.error(`[SHOPIFY SYNC] Variant update failed for product ${shopifyProductId}:`, err.message);
            }
        }

        // Persist sync state
        const stateUpserts = [];
        for (const [pid, updates] of successMap) {
            const product = productMap.get(pid);
            const ids = resolvedIds.get(pid);
            const setFields = {
                productId: product._id,
                sku: product.sku,
                shopifyProductId: ids.shopifyProductId,
                variantId: ids.variantId,
                inventoryItemId: ids.inventoryItemId,
                locationId: ids.locationId,
                shopifySkuMissing: false,
                lastSyncedAt: now
            };
            if ('quantity' in updates) setFields.lastSyncedQuantity = updates.quantity;
            if ('price' in updates) setFields.lastSyncedPrice = updates.price;
            if ('cost' in updates) setFields.lastSyncedCost = updates.cost;
            if ('barcode' in updates) setFields.lastSyncedBarcode = updates.barcode;

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

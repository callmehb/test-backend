'use strict';

const Product = require('../models/Product');
const ShopifySyncState = require('../models/ShopifySyncState');

const SHOPIFY_URL = `https://${process.env.STORE}/admin/api/2026-01/graphql.json`;
const SHOPIFY_HEADERS = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': process.env.TOKEN
};

const BATCH_SIZE = 100; // Shopify inventorySetQuantities limit per call

async function shopifyGraphQL(query, variables = {}) {
    const res = await fetch(SHOPIFY_URL, {
        method: 'POST',
        headers: SHOPIFY_HEADERS,
        body: JSON.stringify({ query, variables })
    });
    if (!res.ok) {
        throw new Error(`Shopify HTTP ${res.status}: ${await res.text()}`);
    }
    const json = await res.json();
    if (json.errors) {
        throw new Error(`Shopify GQL errors: ${JSON.stringify(json.errors)}`);
    }
    return json;
}

async function fetchShopifyIds(sku) {
    const query = `
        query($q: String!) {
            productVariants(first: 1, query: $q) {
                edges {
                    node {
                        inventoryItem {
                            id
                            inventoryLevels(first: 1) {
                                edges {
                                    node {
                                        location { id }
                                    }
                                }
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
    const item = edges[0].node.inventoryItem;
    const levelEdges = item.inventoryLevels.edges;
    if (!levelEdges.length) return null;
    return {
        inventoryItemId: item.id,
        locationId: levelEdges[0].node.location.id
    };
}

async function sendBulkMutation(items) {
    const mutation = `
        mutation($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) {
                userErrors { field message }
            }
        }
    `;
    const json = await shopifyGraphQL(mutation, {
        input: {
            name: "available",
            reason: "correction",
            ignoreCompareQuantity: true,
            quantities: items.map(i => ({
                inventoryItemId: i.inventoryItemId,
                locationId: i.locationId,
                quantity: i.quantity
            }))
        }
    });
    const userErrors = json.data.inventorySetQuantities.userErrors;
    if (userErrors.length) {
        throw new Error(`inventorySetQuantities userErrors: ${JSON.stringify(userErrors)}`);
    }
    return json;
}

async function runSync() {
    console.log('[SHOPIFY SYNC] Starting sync run at', new Date().toISOString());
    try {
        const products = await Product.find(
            { trackQuantity: true, sku: { $exists: true, $ne: '' } },
            { _id: 1, sku: 1, quantity: 1 }
        ).lean();

        if (!products.length) {
            console.log('[SHOPIFY SYNC] No trackable products with SKUs. Skipping.');
            return;
        }

        const syncStates = await ShopifySyncState.find(
            { productId: { $in: products.map(p => p._id) } }
        ).lean();
        const stateMap = new Map(syncStates.map(s => [s.productId.toString(), s]));

        const bulkMutationItems = [];
        const missingSkuUpserts = [];

        for (const product of products) {
            const state = stateMap.get(product._id.toString());

            // Reset cached Shopify IDs if SKU changed on the product
            if (state && state.sku !== product.sku) {
                state.inventoryItemId = null;
                state.locationId = null;
                state.shopifySkuMissing = false;
            }

            if (state?.shopifySkuMissing) continue;

            const quantityChanged = !state || state.lastSyncedQuantity !== product.quantity;
            if (!quantityChanged) continue;

            let { inventoryItemId, locationId } = state || {};

            if (!inventoryItemId || !locationId) {
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
                    inventoryItemId = ids.inventoryItemId;
                    locationId = ids.locationId;
                } catch (fetchErr) {
                    console.error(`[SHOPIFY SYNC] Failed to fetch Shopify IDs for SKU "${product.sku}":`, fetchErr.message);
                    continue;
                }
            }

            bulkMutationItems.push({ inventoryItemId, locationId, quantity: product.quantity, productId: product._id, sku: product.sku });
        }

        // Persist SKU-not-found markers regardless of mutation outcome
        if (missingSkuUpserts.length) {
            await ShopifySyncState.bulkWrite(missingSkuUpserts).catch(e =>
                console.error('[SHOPIFY SYNC] Failed to write missing SKU markers:', e.message)
            );
        }

        if (!bulkMutationItems.length) {
            console.log('[SHOPIFY SYNC] No quantity changes to push.');
            return;
        }

        // Chunk into batches of BATCH_SIZE to respect Shopify's per-call limit
        const batches = [];
        for (let i = 0; i < bulkMutationItems.length; i += BATCH_SIZE) {
            batches.push(bulkMutationItems.slice(i, i + BATCH_SIZE));
        }

        const now = new Date();
        const stateUpserts = [];

        for (const batch of batches) {
            try {
                await sendBulkMutation(batch);
                for (const item of batch) {
                    stateUpserts.push({
                        updateOne: {
                            filter: { productId: item.productId },
                            update: { $set: {
                                productId: item.productId,
                                sku: item.sku,
                                lastSyncedQuantity: item.quantity,
                                inventoryItemId: item.inventoryItemId,
                                locationId: item.locationId,
                                shopifySkuMissing: false,
                                lastSyncedAt: now
                            }},
                            upsert: true
                        }
                    });
                }
                console.log(`[SHOPIFY SYNC] Pushed ${batch.length} item(s) to Shopify.`);
            } catch (mutErr) {
                console.error('[SHOPIFY SYNC] Bulk mutation failed for batch:', mutErr.message);
            }
        }

        if (stateUpserts.length) {
            await ShopifySyncState.bulkWrite(stateUpserts).catch(e =>
                console.error('[SHOPIFY SYNC] Failed to write sync state:', e.message)
            );
        }

        console.log('[SHOPIFY SYNC] Sync run complete.');
    } catch (err) {
        console.error('[SHOPIFY SYNC] Unexpected error in runSync:', err.message);
    }
}

module.exports = { runSync };

'use strict';

const cron = require('node-cron');
const { runSync } = require('../services/shopifySync');

function startShopifySyncJob() {
    cron.schedule('*/2 * * * *', async () => {
        try {
            await runSync();
        } catch (err) {
            console.error('[SHOPIFY SYNC CRON] Unhandled error:', err.message);
        }
    });
    console.log('[SHOPIFY SYNC CRON] Shopify sync job scheduled (every 15 minutes).');
}

module.exports = { startShopifySyncJob };

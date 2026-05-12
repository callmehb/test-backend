'use strict';

const cron = require('node-cron');
const { runSync } = require('../services/shopifySync');

async function safeRun() {
    try {
        await runSync();
    } catch (err) {
        console.error('[SHOPIFY SYNC CRON] Unhandled error:', err.message);
    }
}

function startShopifySyncJob() {
    console.log('[SHOPIFY SYNC CRON] Scheduling sync job (every 2 minutes)...');
    cron.schedule('*/2 * * * *', safeRun);
    // Kick off one run immediately so we don't wait for the first tick
    safeRun();
    console.log('[SHOPIFY SYNC CRON] Shopify sync job scheduled.');
}

module.exports = { startShopifySyncJob };

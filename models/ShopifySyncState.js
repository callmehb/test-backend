const mongoose = require('mongoose');

const shopifySyncStateSchema = new mongoose.Schema({
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true,
        unique: true,
        index: true
    },
    sku: { type: String, required: true },
    lastSyncedQuantity: { type: Number, default: null },
    inventoryItemId: { type: String, default: null },
    locationId: { type: String, default: null },
    shopifySkuMissing: { type: Boolean, default: false },
    lastSyncedAt: { type: Date, default: null }
}, { versionKey: false });

module.exports = mongoose.model('ShopifySyncState', shopifySyncStateSchema);

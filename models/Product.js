const mongoose = require('mongoose');
const fs = require('fs').promises;
const path = require('path');

const productSchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: { type: String },
    category: { type: String },
    price: { type: Number, default: 0 },
    cost: { type: Number, default: 0 },
    sku: { type: String },
    barcode: { type: String },
    trackQuantity: { type: Boolean, default: false },
    quantity: { type: Number, default: 0 },
    lowStock: { type: Number, default: 0 },
    supplier: { type: String },
    inventoryLocation: { type: String },
    images: [{ type: String }]
});

// Middleware to delete images before deleting products
productSchema.pre('deleteMany', async function (next) {
    try {
        const products = await this.model.find(this.getFilter());
        for (const product of products) {
            for (const image of product.images) {
                const imagePath = path.join(__dirname, '../Uploads', image);
                try {
                    await fs.access(imagePath); // Check if file exists
                    await fs.unlink(imagePath);
                } catch (err) {
                    if (err.code !== 'ENOENT') {
                        console.error(`Failed to delete image ${image}:`, err);
                    }
                }
            }
        }
        next();
    } catch (err) {
        next(err);
    }
});

module.exports = mongoose.model('Product', productSchema);
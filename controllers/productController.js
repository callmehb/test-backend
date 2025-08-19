const mongoose = require('mongoose');
const Product = require('../models/Product');
const Ticket = require('../models/Ticket');
const fs = require('fs').promises;
const path = require('path');

const createProduct = async (req, res) => {
    const { title, price } = req.body;
    if (!title) {
        return res.status(400).json({ message: "Title is required" });
    }
    if (!req.body.sku) delete req.body.sku;
    if (!req.body.barcode) delete req.body.barcode;
    if (typeof price === 'undefined' || price === null) {
        req.body.price = 0;
    } else if (isNaN(price) || price < 0) {
        return res.status(400).json({ message: "Price must be a non-negative number" });
    }
    try {
        const images = []; // Ignore req.files for now
        if (req.files && req.files.length > 0) {
            console.log('Images received but ignored');
        }
        const product = new Product({ ...req.body, images });
        await product.save();
        res.status(201).json({ message: "Product created", product });
    } catch (error) {
        console.error(`[ERROR] [${req.method} ${req.originalUrl}]`, error.message);
        res.status(500).json({ message: "Failed to create product" });
    }
};

const updateProduct = async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid product ID" });
    }
    try {
        const product = await Product.findById(id);
        if (!product) {
            return res.status(404).json({ message: "Product not found" });
        }
        if (typeof updates.price === 'undefined' || updates.price === null) {
            updates.price = 0;
        } else if (isNaN(updates.price) || updates.price < 0) {
            return res.status(400).json({ message: "Price must be a non-negative number" });
        }
        if (req.files && req.files.length > 0) {
            console.log('Images received but ignored');
        }
        updates.images = product.images; // Preserve existing images or []
        Object.assign(product, updates);
        await product.save();
        res.status(200).json({ message: "Product updated", product });
    } catch (error) {
        console.error(`[ERROR] [${req.method} ${req.originalUrl}]`, error.message);
        res.status(500).json({ message: "Failed to update product" });
    }
};

const getAllProducts = async (req, res) => {
    try {
        const products = await Product.find();
        res.status(200).json(products);
    } catch (error) {
        console.error(`[ERROR] [${req.method} ${req.originalUrl}]`, error.message);
        res.status(500).json({ message: "Failed to get all products" });
    }
};

const getSingleProduct = async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid product ID" });
    }
    try {
        const product = await Product.findById(id);
        if (!product) {
            return res.status(404).json({ message: "Product not found" });
        }
        res.status(200).json(product);
    } catch (error) {
        console.error(`[ERROR] [${req.method} ${req.originalUrl}]`, error.message);
        res.status(500).json({ message: "Failed to fetch product" });
    }
};

const deleteManyProducts = async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: "Expected a non-empty array of product IDs" });
    }
    const areValidIds = ids.every(id => mongoose.Types.ObjectId.isValid(id));
    if (!areValidIds) {
        return res.status(400).json({ message: "One or more product IDs are invalid" });
    }
    try {
        const result = await Product.deleteMany({ _id: { $in: ids } });
        if (result.deletedCount === 0) {
            return res.status(404).json({ message: "No products found to delete" });
        }
        res.status(200).json({ message: `${result.deletedCount} products deleted` });
    } catch (error) {
        console.error(`[ERROR] [${req.method} ${req.originalUrl}]`, error.message);
        res.status(500).json({ message: "Failed to delete products" });
    }
};

const deductManyProducts = async (req, res) => {
    const { items, ticketId } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "Expected a non-empty array of items" });
    }
    if (!mongoose.Types.ObjectId.isValid(ticketId)) {
        return res.status(400).json({ message: "Invalid ticket ID" });
    }
    for (const item of items) {
        if (!mongoose.Types.ObjectId.isValid(item.productId)) {
            return res.status(400).json({ message: `Invalid product ID: ${item.productId}` });
        }
        if (!item.quantity || item.quantity <= 0) {
            return res.status(400).json({ message: "Quantity must be greater than 0" });
        }
    }
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const ticket = await Ticket.findById(ticketId).session(session);
        if (!ticket) {
            throw new Error('Ticket not found');
        }
        if (ticket.status === 'deducted') {
            throw new Error('Ticket already deducted');
        }
        const updatedProducts = [];
        for (const item of items) {
            const product = await Product.findById(item.productId).session(session);
            if (!product) {
                throw new Error(`Product not found: ${item.productId}`);
            }
            if (!product.trackQuantity) {
                throw new Error(`Product ${product.title} does not track quantity`);
            }
            if (product.quantity < item.quantity) {
                throw new Error(`Not enough stock for product: ${product.title}`);
            }
            product.quantity -= item.quantity;
            await product.save({ session });
            updatedProducts.push({
                productId: product._id,
                title: product.title,
                deducted: item.quantity,
                remaining: product.quantity
            });
        }
        ticket.items = items;
        ticket.status = 'deducted';
        ticket.deductedAt = new Date();
        await ticket.save({ session });
        await session.commitTransaction();
        res.status(200).json({ message: "Quantities deducted successfully", updatedProducts, ticket });
    } catch (error) {
        await session.abortTransaction();
        console.error(`[ERROR] [${req.method} ${req.originalUrl}]`, error.message);
        res.status(500).json({ message: error.message || "Failed to deduct quantities" });
    } finally {
        session.endSession();
    }
};

const deleteProductImage = async (req, res) => {
    const { id, imageName } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid product ID" });
    }
    try {
        const product = await Product.findById(id);
        if (!product) {
            return res.status(404).json({ message: "Product not found" });
        }
        product.images = product.images.filter(img => img !== imageName);
        await product.save();
        const imagePath = path.join(__dirname, '../Uploads', imageName);
        try {
            await fs.access(imagePath);
            await fs.unlink(imagePath);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error(`Failed to delete image ${imageName}:`, err);
            }
        }
        res.status(200).json({ message: "Image deleted successfully" });
    } catch (error) {
        console.error(`[ERROR] [${req.method} ${req.originalUrl}]`, error.message);
        res.status(500).json({ message: "Error deleting image" });
    }
};

module.exports = {
    createProduct,
    getAllProducts,
    getSingleProduct,
    updateProduct,
    deleteManyProducts,
    deductManyProducts,
    deleteProductImage
};
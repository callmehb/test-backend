console.log('[SERVER] Booting — Shopify sync build active');

const express = require('express');
const dotenv = require('dotenv');
const connectDB = require('./config/db');
const productRoutes = require('./routes/products');
const ticketRoutes = require('./routes/ticket');
const { router: authRoutes, authenticateToken } = require('./routes/auth');
const cors = require('cors');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Connect to MongoDB (Mongoose buffers queries until connected)
connectDB();

// Start the Shopify sync cron unconditionally — it tolerates the DB not being ready yet
try {
    const { startShopifySyncJob } = require('./cron/shopifySyncJob');
    startShopifySyncJob();
} catch (err) {
    console.error('[SERVER] Failed to start Shopify sync job:', err.message, err.stack);
}

// Routes
app.use('/api/products', authenticateToken, productRoutes);
app.use('/api/tickets', authenticateToken, ticketRoutes);
app.use('/api/auth', authRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
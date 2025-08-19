const mongoose = require('mongoose');

const ticketItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  title: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  price: { type: Number, required: true, min: 0 }
});

const ticketSchema = new mongoose.Schema({
  ticketNumber: { type: Number, required: true, unique: true },
  items: [ticketItemSchema],
  status: { type: String, enum: ['active', 'deducted'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date },
  deductedAt: { type: Date }
}, { versionKey: false });

module.exports = mongoose.model('Ticket', ticketSchema);
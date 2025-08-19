const mongoose = require('mongoose');
const Ticket = require('../models/Ticket');
const Product = require('../models/Product');

const createTicket = async (req, res) => {
  try {
    const lastTicket = await Ticket.findOne().sort({ ticketNumber: -1 });
    const ticketNumber = lastTicket ? lastTicket.ticketNumber + 1 : 1;
    const ticket = new Ticket({ ticketNumber, items: [], createdAt: new Date() });
    await ticket.save();
    res.status(201).json({ message: 'Ticket created', ticket });
  } catch (error) {
    console.error(`[ERROR] [${req.method} ${req.originalUrl}]`, error.message, error.stack);
    res.status(500).json({ message: 'Failed to create ticket', error: error.message });
  }
};

const getTickets = async (req, res) => {
  try {
    const tickets = await Ticket.find().sort({ ticketNumber: -1 });
    res.status(200).json(tickets);
  } catch (error) {
    console.error(`[ERROR] [${req.method} ${req.originalUrl}]`, error.message, error.stack);
    res.status(500).json({ message: 'Failed to fetch tickets', error: error.message });
  }
};

const getTicketById = async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    res.status(200).json(ticket);
  } catch (error) {
    console.error(`[ERROR] [${req.method} ${req.originalUrl}]`, error.message, error.stack);
    res.status(500).json({ message: 'Failed to fetch ticket', error: error.message });
  }
};

const updateTicketItems = async (req, res) => {
  try {
    const { id } = req.params;
    const { items } = req.body;

    // Validate ticket ID
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid ticket ID' });
    }

    // Validate items
    if (!Array.isArray(items)) {
      return res.status(400).json({ message: 'Items must be an array' });
    }

    // Validate each item
    for (const item of items) {
      if (!mongoose.isValidObjectId(item.productId)) {
        return res.status(400).json({ message: `Invalid product ID: ${item.productId}` });
      }
      if (!item.title || typeof item.title !== 'string') {
        return res.status(400).json({ message: `Invalid title for product ${item.productId}` });
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 0) {
        return res.status(400).json({ message: `Invalid quantity for ${item.title}: ${item.quantity}` });
      }
      if (typeof item.price !== 'number' || item.price < 0) {
        return res.status(400).json({ message: `Invalid price for ${item.title}: ${item.price}` });
      }
      const product = await Product.findById(item.productId);
      if (!product) {
        return res.status(404).json({ message: `Product ${item.title} not found` });
      }
      if (product.trackQuantity) {
        // Calculate reserved quantity excluding the current ticket
        const reserved = (await Ticket.find({ status: 'active', _id: { $ne: id } }))
          .reduce((sum, ticket) => {
            const ticketItem = ticket.items.find(i => i.productId.toString() === item.productId.toString());
            return sum + (ticketItem ? ticketItem.quantity : 0);
          }, 0);
        const available = product.quantity - reserved;
        if (item.quantity > available) {
          return res.status(400).json({ message: `Not enough stock for ${item.title}. Available: ${available}` });
        }
      }
    }

    // Atomically update ticket items
    const ticket = await Ticket.findOneAndUpdate(
      { _id: id, status: 'active' },
      {
        $set: {
          items: items.map(item => ({
            productId: item.productId,
            title: item.title,
            quantity: item.quantity,
            price: item.price
          })),
          updatedAt: new Date()
        }
      },
      { new: true, runValidators: true }
    );

    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found or already deducted' });
    }

    res.status(200).json({ message: 'Ticket items updated successfully', ticket });
  } catch (error) {
    console.error(`[ERROR] [${req.method} ${req.originalUrl}]`, error.message, error.stack);
    res.status(500).json({ message: `Failed to update ticket items: ${error.message}` });
  }
};

const deductItems = async (req, res) => {
  try {
    const { items, ticketId } = req.body;
    if (!mongoose.isValidObjectId(ticketId)) {
      return res.status(400).json({ message: 'Invalid ticket ID' });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'No items provided' });
    }

    const ticket = await Ticket.findById(ticketId);
    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }
    if (ticket.status === 'deducted') {
      return res.status(400).json({ message: 'Ticket already deducted' });
    }

    const updatedProducts = [];
    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product) {
        return res.status(404).json({ message: `Product ${item.title} not found` });
      }
      if (!product.trackQuantity) {
        return res.status(400).json({ message: `Product ${item.title} does not track quantity` });
      }
      // Calculate reserved quantity excluding the current ticket
      const reserved = (await Ticket.find({ status: 'active', _id: { $ne: ticketId } }))
        .reduce((sum, t) => {
          const ticketItem = t.items.find(i => i.productId.toString() === item.productId.toString());
          return sum + (ticketItem ? ticketItem.quantity : 0);
        }, 0);
      const available = product.quantity - reserved;
      if (item.quantity > available) {
        return res.status(400).json({ message: `Not enough stock for ${item.title}. Available: ${available}` });
      }
      product.quantity -= item.quantity;
      await product.save();
      updatedProducts.push({ _id: product._id, title: product.title, deducted: item.quantity });
    }

    // Update ticket items before marking as deducted
    ticket.items = items.map(item => ({
      productId: item.productId,
      title: item.title,
      quantity: item.quantity,
      price: item.price || 0
    }));
    ticket.status = 'deducted';
    ticket.deductedAt = new Date();
    ticket.updatedAt = new Date();
    await ticket.save();

    res.status(200).json({ message: 'Items deducted successfully', updatedProducts, ticket });
  } catch (error) {
    console.error(`[ERROR] [${req.method} ${req.originalUrl}]`, error.message, error.stack);
    res.status(500).json({ message: `Failed to deduct items: ${error.message}` });
  }
};

const clearDeductedTickets = async (req, res) => {
  try {
    await Ticket.deleteMany({ status: 'deducted' });
    res.status(200).json({ message: 'Deducted tickets cleared' });
  } catch (error) {
    console.error(`[ERROR] [${req.method} ${req.originalUrl}]`, error.message, error.stack);
    res.status(500).json({ message: 'Failed to clear deducted tickets', error: error.message });
  }
};

const deleteTicket = async (req, res) => {
  try {
    const ticketId = req.params.id;
    if (!mongoose.isValidObjectId(ticketId)) {
      return res.status(400).json({ message: 'Invalid ticket ID' });
    }
    const ticket = await Ticket.findById(ticketId);
    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }
    if (ticket.status === 'deducted') {
      return res.status(400).json({ message: 'Cannot delete deducted ticket' });
    }
    await Ticket.deleteOne({ _id: ticketId, status: 'active' });
    res.status(200).json({ message: 'Ticket deleted successfully' });
  } catch (error) {
    console.error(`[ERROR] [${req.method} ${req.originalUrl}]`, error.message, error.stack);
    res.status(500).json({ message: 'Failed to delete ticket', error: error.message });
  }
};

module.exports = {
  createTicket,
  getTickets,
  getTicketById,
  updateTicketItems,
  deductItems,
  clearDeductedTickets,
  deleteTicket
};

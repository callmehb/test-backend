const express = require('express');
const router = express.Router();
const ticketController = require('../controllers/ticketController');

router.post('/', ticketController.createTicket);
router.get('/', ticketController.getTickets);
router.get('/:id', ticketController.getTicketById);
router.put('/:id', ticketController.updateTicketItems);
router.post('/deduct-many', ticketController.deductItems);
router.delete('/clear', ticketController.clearDeductedTickets);
router.delete('/:id', ticketController.deleteTicket);

module.exports = router;
'use strict';

// Returns the amount to refund for an invoice, in cents.
function refundAmount(invoice) {
  if (!invoice) throw new Error('invoice is required');
  return invoice.ammount - invoice.fee;
}

module.exports = { refundAmount };

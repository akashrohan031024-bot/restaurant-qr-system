const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const GOOGLE_SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbzB26bkeD8LZTykFuLHyGkLgDKa13QlzvUluGxgvbMt4IHCF6XDPeQAmD2Lq-PrlNWI/exec";

async function logToGoogleSheet(payload) {
  if (!GOOGLE_SHEET_WEBHOOK_URL || GOOGLE_SHEET_WEBHOOK_URL.includes("YOUR_APPS_SCRIPT")) {
    console.log("Sheet webhook URL not configured yet. Skipping Google Sheet sync.");
    return;
  }
  try {
    const response = await fetch(GOOGLE_SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    console.log("Logged to Google Sheet:", result);
    return result;
  } catch (err) {
    console.error("Failed to sync to Google Sheet:", err);
  }
}

// REST ENDPOINT: Add & Log Expenses directly (Staff / Groceries / LPG)
app.post('/api/expenses', async (req, res) => {
  const { category, description, amount } = req.body;
  if (!category || !amount) {
    return res.status(400).json({ error: "Category and amount are required." });
  }

  const now = new Date();
  const expenseData = {
    type: 'EXPENSE',
    sheet: 'Monthly Expenses',
    date: now.toISOString().split('T')[0],
    category: category,
    description: description || 'Daily operational expense',
    amount: parseFloat(amount)
  };

  try {
    const result = await logToGoogleSheet(expenseData);
    io.emit('expense-added', expenseData);
    res.json({ success: true, message: "Expense logged successfully", data: expenseData, result });
  } catch (err) {
    res.status(500).json({ error: "Failed to record expense", details: err.message });
  }
});

const RESTAURANT_WIFI = {
  ssid: "Hotel_Triveni_Guest",
  password: "Triveni@PureVeg"
};

const tables = {
  1: { status: 'idle', total: 0, orders: [], waiterCalled: false, billRequested: false, cashRequested: false, paid: false },
  2: { status: 'idle', total: 0, orders: [], waiterCalled: false, billRequested: false, cashRequested: false, paid: false },
  3: { status: 'idle', total: 0, orders: [], waiterCalled: false, billRequested: false, cashRequested: false, paid: false },
  4: { status: 'idle', total: 0, orders: [], waiterCalled: false, billRequested: false, cashRequested: false, paid: false },
  5: { status: 'idle', total: 0, orders: [], waiterCalled: false, billRequested: false, cashRequested: false, paid: false },
  6: { status: 'idle', total: 0, orders: [], waiterCalled: false, billRequested: false, cashRequested: false, paid: false }
};

io.on('connection', (socket) => {
  // Sync state to the connecting client
  socket.emit('tables-sync', tables);

  // Single order placement handler (NO DUPLICATES)
  socket.on('order-placed', (data) => {
    try {
      const tableId = data.tableId || (data.table ? parseInt(data.table.replace(/\D/g, '')) : 1) || 1;
      const table = tables[tableId];
      if (!table) return;

      const roundTotal = parseFloat(data.total || data.roundTotal || 0);
      table.status = 'occupied';
      table.total += roundTotal;

      const newOrder = {
        orderId: data.orderId || `#${Math.floor(1000 + Math.random() * 9000)}`,
        tableId: tableId,
        table: `Table ${tableId}`,
        items: data.items || [],
        roundTotal: roundTotal,
        round: data.round || (table.orders.length + 1),
        time: data.time || data.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };

      table.orders.push(newOrder);

      // Broadcast ONCE to Kitchen Display Screen and Floor management
      io.emit('new-kitchen-order', newOrder);
      io.emit('table-updated', { tableId, table });
      io.emit('tables-sync', tables);

      console.log(`[ORDER DISPATCHED] ${newOrder.table} Order ${newOrder.orderId}: ${newOrder.items.length} items`);
    } catch (err) {
      console.error("Order processing error:", err);
    }
  });

  // Handle Order Modifications / Cancellations
  socket.on('order-modified', (data) => {
    const tableId = data.tableId || 1;
    io.emit('kitchen-order-modified', data);

    io.emit('staff-alert', {
      type: 'warning',
      tableId: tableId,
      message: `⚠️ ${data.table || 'Table ' + tableId} MODIFIED: ${data.itemName} (${data.oldQty} ➔ ${data.newQty})`
    });

    console.log(`Table ${tableId} modified item:`, data);
  });

  // Call Waiter
  socket.on('call-waiter', (data) => {
    const tableId = data.tableId || 1;
    if (tables[tableId]) {
      tables[tableId].waiterCalled = true;
      io.emit('staff-alert', { type: 'waiter', tableId, message: `Table ${tableId} is calling the waiter!` });
      io.emit('tables-sync', tables);
    }
  });

  socket.on('dismiss-waiter', ({ tableId }) => {
    if (tables[tableId]) {
      tables[tableId].waiterCalled = false;
      io.emit('tables-sync', tables);
    }
  });

  // Ask for Bill (UPI Default)
  socket.on('request-bill', (data) => {
    const tableId = data.tableId || 1;
    if (tables[tableId]) {
      tables[tableId].billRequested = true;
      tables[tableId].cashRequested = false;
      io.emit('staff-alert', { type: 'bill', tableId, message: `Table ${tableId} asked for the bill!` });
      io.emit('tables-sync', tables);
    }
  });

  // Handle Customer Choosing Cash
  socket.on('request-cash-payment', ({ tableId, table, total }) => {
    const id = tableId || 1;
    if (tables[id]) {
      tables[id].cashRequested = true;
      tables[id].billRequested = false;
      io.emit('staff-alert', { 
        type: 'cash', 
        tableId: id, 
        message: `💵 ${table || 'Table ' + id} requested CASH payment (${total || '₹' + tables[id].total.toFixed(2)}) - Please collect cash!` 
      });
      io.emit('tables-sync', tables);
    }
  });

  // Pay Bill & Push to Google Sheet
  socket.on('pay-bill', ({ tableId, method }) => {
    const id = tableId || 1;
    const table = tables[id];
    if (table) {
      table.paid = true;
      table.status = 'paid';
      table.billRequested = false;
      table.cashRequested = false;

      const allItems = table.orders.flatMap(o => o.items);
      const itemsSummary = allItems
        .map(i => `${i.qty || 1}x ${i.name}`)
        .join(', ') || 'Dine-in Order';

      const now = new Date();
      const finalAmount = (table.total * 1.05).toFixed(2);

      logToGoogleSheet({
        type: 'PAYMENT',
        sheet: 'Payment History',
        date: now.toISOString().split('T')[0],
        time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        tableNo: `Table ${id}`,
        orderId: table.orders[0]?.orderId || `#${Math.floor(1000 + Math.random() * 9000)}`,
        orderDetails: itemsSummary,
        paymentMethod: method || 'UPI',
        totalAmount: finalAmount
      });

      io.emit('staff-alert', { 
        type: 'paid', 
        tableId: id, 
        message: `Table ${id} paid ₹${finalAmount} via ${method || 'UPI'}!` 
      });

      // Reset internal table state
      table.total = 0;
      table.orders = [];

      // Broadcast clearing events to customer and floor screens
      io.emit(`table-paid-${id}`, { method: method || 'CASH' });
      io.emit(`session-reset-${id}`);
      io.emit('table-cleared', { tableId: id });
      io.emit('tables-sync', tables);
    }
  });

  // Log Expense Socket
  socket.on('log-expense', async (data) => {
    const now = new Date();
    await logToGoogleSheet({
      type: 'EXPENSE',
      sheet: 'Monthly Expenses',
      date: now.toISOString().split('T')[0],
      category: data.category,
      description: data.description,
      amount: parseFloat(data.amount)
    });
    io.emit('tables-sync', tables);
  });

  // Reset Table
  socket.on('reset-table', ({ tableId }) => {
    const id = tableId || 1;
    if (tables[id]) {
      tables[id] = { status: 'idle', total: 0, orders: [], waiterCalled: false, billRequested: false, cashRequested: false, paid: false };
      io.emit(`session-reset-${id}`);
      io.emit(`table-paid-${id}`, { method: 'RESET' });
      io.emit('table-cleared', { tableId: id });
      io.emit('tables-sync', tables);
    }
  });

  socket.on('get-wifi', () => {
    socket.emit('wifi-info', RESTAURANT_WIFI);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
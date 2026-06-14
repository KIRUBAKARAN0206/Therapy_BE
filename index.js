import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import { connectToWhatsApp, sendWhatsAppNotification as sendBaileysNotification, getWhatsAppStatus } from './whatsapp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize dotenv configuration
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS and JSON parsing middleware
app.use(cors());
app.use(express.json());

// Initialize SQLite Database
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database at:', dbPath);
    
    // Create Inquiries table
    db.run(`
      CREATE TABLE IF NOT EXISTS inquiries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        firstName TEXT NOT NULL,
        lastName TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        subject TEXT,
        message TEXT NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) {
        console.error('Error creating inquiries table:', err.message);
      } else {
        console.log('Inquiries table ready.');
      }
    });

    // Create Bookings table
    db.run(`
      CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL,
        service TEXT NOT NULL,
        date TEXT NOT NULL,
        timeSlot TEXT NOT NULL,
        message TEXT,
        status TEXT DEFAULT 'Pending',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) {
        console.error('Error creating bookings table:', err.message);
      } else {
        console.log('Bookings table ready.');
      }
    });

    // Create WhatsApp Auth State table
    db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_auth_state (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `, (err) => {
      if (err) {
        console.error('Error creating whatsapp_auth_state table:', err.message);
      } else {
        console.log('WhatsApp auth state table ready.');
        // Connect Baileys WhatsApp bot
        connectToWhatsApp(db);
      }
    });
  }
});

// Baileys WhatsApp Notification Helper
async function sendWhatsAppNotification(booking) {
  const targetPhone = process.env.WHATSAPP_PHONE || '917812864905';
  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  // Format message text matching user requirements
  const text = 
    `🚨 *THE THERAPY UNIVERSE - New Appointment Request* 🚨\n\n` +
    `👤 *Patient Name:* ${booking.name}\n` +
    `📞 *Phone Number:* ${booking.phone}\n` +
    `📧 *Email Address:* ${booking.email}\n` +
    `💆‍♂️ *Requested Service:* ${booking.service}\n` +
    `📅 *Preferred Date:* ${booking.date}\n` +
    `🕒 *Preferred Time Slot:* ${booking.timeSlot}\n` +
    `📝 *Notes / Describe Symptoms:* ${booking.message || 'None'}\n\n` +
    `🔔 *Status:* ${booking.status}\n` +
    `⏰ *Submitted At:* ${timestamp}`;

  return await sendBaileysNotification(targetPhone, text);
}

// Health Check API
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'THE THERAPY UNIVERSE backend API is running.'
  });
});

/* ==========================================================================
   INQUIRIES API ENDPOINTS
   ========================================================================== */

// GET /api/inquiries
app.get('/api/inquiries', (req, res) => {
  const query = `SELECT * FROM inquiries ORDER BY createdAt DESC`;
  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Error fetching inquiries:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
    res.json(rows);
  });
});

// POST /api/inquiries
app.post('/api/inquiries', (req, res) => {
  const { firstName, lastName, email, phone, subject, message } = req.body;

  if (!firstName || !lastName || !email || !message) {
    return res.status(400).json({ error: 'Please fill in all required fields.' });
  }

  const query = `
    INSERT INTO inquiries (firstName, lastName, email, phone, subject, message)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  const params = [firstName, lastName, email, phone || '', subject || 'General Inquiry', message];

  db.run(query, params, function (err) {
    if (err) {
      console.error('Error inserting inquiry:', err.message);
      return res.status(500).json({ error: 'Failed to save inquiry to database.' });
    }
    
    db.get('SELECT * FROM inquiries WHERE id = ?', [this.lastID], (err, row) => {
      if (err) {
        return res.status(201).json({ success: true, id: this.lastID });
      }
      res.status(201).json({ success: true, inquiry: row });
    });
  });
});

// DELETE /api/inquiries/:id
app.delete('/api/inquiries/:id', (req, res) => {
  const { id } = req.params;
  const query = `DELETE FROM inquiries WHERE id = ?`;

  db.run(query, [id], function (err) {
    if (err) {
      console.error(`Error deleting inquiry:`, err.message);
      return res.status(500).json({ error: 'Failed to delete inquiry.' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Inquiry not found.' });
    }
    res.json({ success: true, message: `Inquiry deleted successfully.` });
  });
});

/* ==========================================================================
   BOOKINGS API ENDPOINTS
   ========================================================================== */

// GET /api/bookings
app.get('/api/bookings', (req, res) => {
  const query = `SELECT * FROM bookings ORDER BY createdAt DESC`;
  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Error fetching bookings:', err.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }
    res.json(rows);
  });
});

// POST /api/bookings
app.post('/api/bookings', (req, res) => {
  const { name, email, phone, service, date, timeSlot, message, status } = req.body;

  if (!name || !email || !phone || !service || !date || !timeSlot) {
    return res.status(400).json({ error: 'Please provide all required booking fields.' });
  }

  const query = `
    INSERT INTO bookings (name, email, phone, service, date, timeSlot, message, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [name, email, phone, service, date, timeSlot, message || '', status || 'Pending'];

  db.run(query, params, function (err) {
    if (err) {
      console.error('Error inserting booking:', err.message);
      return res.status(500).json({ error: 'Failed to save appointment.' });
    }

    const insertedId = this.lastID;
    
    db.get('SELECT * FROM bookings WHERE id = ?', [insertedId], async (err, row) => {
      if (err || !row) {
        return res.status(201).json({ success: true, id: insertedId, whatsappFailed: true });
      }

      // Send automated WhatsApp notification
      const whatsappSuccess = await sendWhatsAppNotification(row);

      res.status(201).json({
        success: true,
        booking: row,
        whatsappFailed: !whatsappSuccess
      });
    });
  });
});

// PUT /api/bookings/:id (Update status)
app.put('/api/bookings/:id', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'Status is required.' });
  }

  const query = `UPDATE bookings SET status = ? WHERE id = ?`;
  db.run(query, [status, id], function (err) {
    if (err) {
      console.error('Error updating booking status:', err.message);
      return res.status(500).json({ error: 'Failed to update booking status.' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    res.json({ success: true });
  });
});

// DELETE /api/bookings/:id
app.delete('/api/bookings/:id', (req, res) => {
  const { id } = req.params;
  const query = `DELETE FROM bookings WHERE id = ?`;

  db.run(query, [id], function (err) {
    if (err) {
      console.error('Error deleting booking:', err.message);
      return res.status(500).json({ error: 'Failed to delete booking.' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    res.json({ success: true });
  });
});

// GET /api/admin/whatsapp-status
app.get('/api/admin/whatsapp-status', (req, res) => {
  try {
    const status = getWhatsAppStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting WhatsApp status:', error.message);
    res.status(500).json({ error: 'Failed to retrieve WhatsApp status.' });
  }
});

// POST /api/admin/whatsapp-reconnect
app.post('/api/admin/whatsapp-reconnect', (req, res) => {
  try {
    connectToWhatsApp(db);
    res.json({ success: true, message: 'WhatsApp reconnect sequence triggered.' });
  } catch (error) {
    console.error('Error triggering WhatsApp reconnect:', error.message);
    res.status(500).json({ error: 'Failed to trigger reconnect sequence.' });
  }
});

// Start backend server
app.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});

import express from 'express';
import cors from 'cors';
import pg from 'pg';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { connectToWhatsApp, sendWhatsAppNotification as sendBaileysNotification, getWhatsAppStatus, resetWhatsAppAuth } from './whatsapp.js';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize dotenv configuration
dotenv.config();

// Register global error handlers to prevent unhandled rejections/exceptions from crashing the server
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ [Global Unhandled Rejection] at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('⚠️ [Global Uncaught Exception] thrown:', error);
});

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS and JSON parsing middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Ensure uploads/gallery directory exists
const uploadsGalleryPath = path.join(__dirname, 'uploads', 'gallery');
if (!fs.existsSync(uploadsGalleryPath)) {
  fs.mkdirSync(uploadsGalleryPath, { recursive: true });
}

// Serve static files from uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Initialize PostgreSQL Connection Pool
const poolConfig = process.env.DATABASE_URL
  ? { 
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    }
  : {
      user: process.env.PGUSER || 'postgres',
      host: process.env.PGHOST || 'localhost',
      database: process.env.PGDATABASE || 'therapy_db',
      password: process.env.PGPASSWORD || 'postgres',
      port: parseInt(process.env.PGPORT || '5432', 10),
      ssl: false
    };

const pool = new Pool(poolConfig);

// Initialize Database Tables
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inquiries (
        id SERIAL PRIMARY KEY,
        "firstName" VARCHAR(255) NOT NULL,
        "lastName" VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        phone VARCHAR(100),
        subject VARCHAR(255),
        message TEXT NOT NULL,
        "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        phone VARCHAR(100) NOT NULL,
        service VARCHAR(255) NOT NULL,
        date VARCHAR(100) NOT NULL,
        "timeSlot" VARCHAR(100) NOT NULL,
        message TEXT,
        status VARCHAR(100) DEFAULT 'Pending',
        "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS whatsapp_auth_state (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gallery_images (
        id TEXT PRIMARY KEY,
        title VARCHAR(255),
        category VARCHAR(255),
        url TEXT,
        "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Connected to PostgreSQL and verified database tables.');
    // Connect Baileys WhatsApp bot
    connectToWhatsApp(pool);
  } catch (err) {
    console.error('⚠️ PostgreSQL connection/initialization error:', err.message);
    console.error('Make sure PostgreSQL server is running and database exists!');
  }
}

initDb();

// Baileys WhatsApp Notification Helper — In-clinic Appointment
async function sendWhatsAppNotification(booking) {
  const targetPhone = process.env.WHATSAPP_PHONE || '918220952580';
  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const text = 
    `🚨 *THE THERAPY UNIVERSE - New Appointment Request* 🚨\n\n` +
    `👤 *Patient Name:* ${booking.name}\n` +
    `📞 *Phone Number:* ${booking.phone}\n` +
    `📧 *Email Address:* ${booking.email}\n` +
    `💆‍♂️ *Requested Service:* ${booking.service}\n` +
    `📅 *Preferred Date:* ${booking.date}\n` +
    `📝 *Notes / Describe Symptoms:* ${booking.message || 'None'}\n\n` +
    `🔔 *Status:* ${booking.status}\n` +
    `⏰ *Submitted At:* ${timestamp}`;

  return await sendBaileysNotification(targetPhone, text);
}

// Baileys WhatsApp Notification Helper — Online Consultation
async function sendOnlineConsultWhatsAppNotification(booking) {
  const targetPhone = process.env.WHATSAPP_PHONE || '918220952580';
  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const text =
    `🌐 *THE THERAPY UNIVERSE - New Online Consultation Request* 🌐\n\n` +
    `👤 *Patient Name:* ${booking.name}\n` +
    `📞 *Phone Number:* ${booking.phone}\n` +
    `📧 *Email Address:* ${booking.email}\n` +
    `📍 *Patient Location:* ${booking.location || 'Not specified'}\n` +
    `💻 *Video Platform:* ${booking.platform || 'Not specified'}\n` +
    `📅 *Preferred Date:* ${booking.date}\n` +
    `🕒 *Preferred Time Slot:* ${booking.timeSlot || 'Not specified'}\n` +
    `📝 *Symptoms / History:* ${booking.message || 'None'}\n\n` +
    `🔔 *Status:* Pending\n` +
    `⏰ *Submitted At:* ${timestamp}`;

  return await sendBaileysNotification(targetPhone, text);
}

// Health Check API
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'THE THERAPY UNIVERSE backend API is running with PostgreSQL.'
  });
});

/* ==========================================================================
   INQUIRIES API ENDPOINTS
   ========================================================================== */

// GET /api/inquiries
app.get('/api/inquiries', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM inquiries ORDER BY "createdAt" DESC');
    res.json(rows);
  } catch (err) {
    console.error('Error fetching inquiries:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/inquiries
app.post('/api/inquiries', async (req, res) => {
  const { firstName, lastName, email, phone, subject, message } = req.body;

  if (!firstName || !lastName || !email || !message) {
    return res.status(400).json({ error: 'Please fill in all required fields.' });
  }

  try {
    const query = `
      INSERT INTO inquiries ("firstName", "lastName", email, phone, subject, message)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const params = [firstName, lastName, email, phone || '', subject || 'General Inquiry', message];
    const { rows } = await pool.query(query, params);
    res.status(201).json({ success: true, inquiry: rows[0] });
  } catch (err) {
    console.error('Error inserting inquiry:', err.message);
    res.status(500).json({ error: 'Failed to save inquiry to database.' });
  }
});

// DELETE /api/inquiries/:id
app.delete('/api/inquiries/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM inquiries WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Inquiry not found.' });
    }
    res.json({ success: true, message: 'Inquiry deleted successfully.' });
  } catch (err) {
    console.error(`Error deleting inquiry:`, err.message);
    res.status(500).json({ error: 'Failed to delete inquiry.' });
  }
});

/* ==========================================================================
   BOOKINGS API ENDPOINTS
   ========================================================================== */

// GET /api/bookings/booked-slots
app.get('/api/bookings/booked-slots', async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: 'Date is required.' });
  }
  try {
    const { rows } = await pool.query('SELECT "timeSlot" FROM bookings WHERE date = $1 AND status != \'Cancelled\'', [date]);
    const bookedSlots = rows.map(row => row.timeSlot);
    res.json(bookedSlots);
  } catch (err) {
    console.error('Error fetching booked slots:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/bookings
app.get('/api/bookings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bookings ORDER BY "createdAt" DESC');
    res.json(rows);
  } catch (err) {
    console.error('Error fetching bookings:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/bookings
app.post('/api/bookings', async (req, res) => {
  const { name, email, phone, service, date, timeSlot, message, status } = req.body;

  if (!name || !email || !phone || !service || !date) {
    return res.status(400).json({ error: 'Please provide all required booking fields.' });
  }

  try {
    const query = `
      INSERT INTO bookings (name, email, phone, service, date, "timeSlot", message, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    const params = [name, email, phone, service, date, timeSlot || '', message || '', status || 'Pending'];
    const { rows } = await pool.query(query, params);
    const row = rows[0];

    // Send automated WhatsApp notification
    const whatsappSuccess = await sendWhatsAppNotification(row);

    res.status(201).json({
      success: true,
      booking: row,
      whatsappFailed: !whatsappSuccess
    });
  } catch (err) {
    console.error('Error inserting booking:', err.message);
    res.status(500).json({ error: 'Failed to save appointment.' });
  }
});

/* ==========================================================================
   ONLINE CONSULTATION BOOKING ENDPOINT
   ========================================================================== */

// POST /api/online-bookings
app.post('/api/online-bookings', async (req, res) => {
  const { name, email, phone, location, platform, date, timeSlot, message } = req.body;

  if (!name || !email || !phone || !date) {
    return res.status(400).json({ error: 'Please provide all required fields for online consultation.' });
  }

  // Store in the same bookings table with service = 'Online Consultation'
  const service = `Online Consultation${platform ? ` (${platform})` : ''}${location ? ` — ${location}` : ''}`;
  try {
    const query = `
      INSERT INTO bookings (name, email, phone, service, date, "timeSlot", message, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    const params = [name, email, phone, service, date, timeSlot || 'Not specified', message || '', 'Pending'];
    const { rows } = await pool.query(query, params);
    const row = rows[0];

    // Send dedicated Online Consultation WhatsApp notification
    const whatsappSuccess = await sendOnlineConsultWhatsAppNotification({
      ...row,
      platform,
      location
    });

    res.status(201).json({
      success: true,
      booking: row,
      whatsappFailed: !whatsappSuccess
    });
  } catch (err) {
    console.error('Error inserting online booking:', err.message);
    res.status(500).json({ error: 'Failed to save online consultation request.' });
  }
});

// PUT /api/bookings/:id (Update status)
app.put('/api/bookings/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'Status is required.' });
  }

  try {
    const result = await pool.query('UPDATE bookings SET status = $1 WHERE id = $2', [status, id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating booking status:', err.message);
    res.status(500).json({ error: 'Failed to update booking status.' });
  }
});

// DELETE /api/bookings/:id
app.delete('/api/bookings/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM bookings WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting booking:', err.message);
    res.status(500).json({ error: 'Failed to delete booking.' });
  }
});

/* ==========================================================================
   GALLERY API ENDPOINTS
   ========================================================================== */

// GET /api/gallery
app.get('/api/gallery', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM gallery_images ORDER BY "createdAt" DESC');
    res.json(rows);
  } catch (err) {
    console.error('Error fetching gallery images:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/gallery
app.post('/api/gallery', async (req, res) => {
  const { id, title, category, url } = req.body;
  if (!id || !url) {
    return res.status(400).json({ error: 'ID and URL are required.' });
  }

  try {
    const query = `
      INSERT INTO gallery_images (id, title, category, url) 
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE 
      SET title = EXCLUDED.title, category = EXCLUDED.category, url = EXCLUDED.url
    `;
    const params = [id, title || 'Untitled', category || 'General', url];
    await pool.query(query, params);

    res.status(201).json({ 
      success: true, 
      message: 'Image saved directly to database successfully.',
      photo: {
        id,
        title: title || 'Untitled',
        category: category || 'General',
        url: url
      }
    });
  } catch (err) {
    console.error('Error inserting gallery image into database:', err.message);
    res.status(500).json({ error: 'Failed to save gallery image to database.' });
  }
});

// DELETE /api/gallery/:id
app.delete('/api/gallery/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await pool.query('DELETE FROM gallery_images WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Gallery image not found.' });
    }

    res.json({ success: true, message: 'Gallery image deleted successfully from database.' });
  } catch (err) {
    console.error('Error deleting gallery image:', err.message);
    res.status(500).json({ error: 'Failed to delete gallery image.' });
  }
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
    connectToWhatsApp(pool);
    res.json({ success: true, message: 'WhatsApp reconnect sequence triggered.' });
  } catch (error) {
    console.error('Error triggering WhatsApp reconnect:', error.message);
    res.status(500).json({ error: 'Failed to trigger reconnect sequence.' });
  }
});

// POST /api/admin/whatsapp-reset
app.post('/api/admin/whatsapp-reset', async (req, res) => {
  try {
    const success = await resetWhatsAppAuth(pool);
    if (success) {
      res.json({ success: true, message: 'WhatsApp authentication reset and reconnection sequence triggered.' });
    } else {
      res.status(500).json({ error: 'Failed to fully reset WhatsApp auth.' });
    }
  } catch (error) {
    console.error('Error resetting WhatsApp auth:', error.message);
    res.status(500).json({ error: 'Failed to trigger reset sequence.' });
  }
});

// Start backend server
app.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT} with PostgreSQL`);
});

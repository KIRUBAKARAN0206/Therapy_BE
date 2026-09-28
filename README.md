# THE THERAPY UNIVERSE - Backend API Server

This is the backend API server for **THE THERAPY UNIVERSE** clinic application. Built with Node.js, Express, and PostgreSQL.

## Features

- **Inquiries API:** Manages client message inquiries.
- **Bookings API:** Handles appointment scheduling and tracking.
- **WhatsApp Integration:** Automatically sends notifications to the clinic phone using Baileys WhatsApp Web API.
- **PostgreSQL Database:** Production-grade relational database.

## Prerequisites

Make sure you have [Node.js](https://nodejs.org/) installed (v16+ recommended) and a PostgreSQL database (local or cloud like Supabase/Neon).

## Setup & Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure Environment Variables:
   Create a `.env` file in this directory and specify your configuration:
   ```env
   PORT=5000
   WHATSAPP_PHONE=918220952580
   DATABASE_URL=postgres://postgres:postgres@localhost:5432/therapy_db
   ```

3. Run the Server:

   - **Development Mode** (with nodemon hot reloading):
     ```bash
     npm run dev
     ```
   - **Production Mode**:
     ```bash
     npm start
     ```

   The server will run at `http://localhost:5000` and automatically connect to PostgreSQL and initialize database tables.


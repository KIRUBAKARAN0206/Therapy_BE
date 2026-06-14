# THE THERAPY UNIVERSE - Backend API Server

This is the backend API server for **THE THERAPY UNIVERSE** clinic application. Built with Node.js, Express, and SQLite3.

## Features

- **Inquiries API:** Manages client message inquiries.
- **Bookings API:** Handles appointment scheduling and tracking.
- **WhatsApp Integration:** Automatically sends notifications to the clinic phone using CallMeBot.
- **SQLite Database:** Local self-contained lightweight database.

## Prerequisites

Make sure you have [Node.js](https://nodejs.org/) installed (v16+ recommended).

## Setup & Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure Environment Variables:
   Create a `.env` file in this directory and specify your configuration (see `.env` template):
   ```env
   PORT=5000
   WHATSAPP_PHONE=918220952580
   CALLMEBOT_API_KEY=your_key_here
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

   The server will run at `http://localhost:5000` and automatically create a `database.sqlite` file if it doesn't exist.

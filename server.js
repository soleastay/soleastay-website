// ═══════════════════════════════════════════════════════════
// BACKEND — Marseille Apartment Booking
// Node.js + Express + Stripe
//
// Deploy on Railway, Render, or any Node host
// Install: npm install express stripe node-ical cors dotenv node-cron
// Run:     node server.js
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const ical = require('node-ical');
const cron = require('node-cron');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// ── In-memory store (replace with a real DB like Supabase/PlanetScale) ──
let bookings = [];      // confirmed bookings
let depositHolds = [];  // active €100 holds
let blockedDates = [];  // from iCal

// ═══════════════════════════════════════════════════════════
// iCAL SYNC — fetch Airbnb + Booking.com blocked dates
// ═══════════════════════════════════════════════════════════
const ICAL_URLS = (process.env.ICAL_URLS || '').split(',').filter(Boolean);

async function syncCalendars() {
  const dates = new Set();
  for (const url of ICAL_URLS) {
    try {
      const events = await ical.async.fromURL(url);
      for (const key of Object.keys(events)) {
        const ev = events[key];
        if (ev.type !== 'VEVENT') continue;
        const start = new Date(ev.start);
        const end = new Date(ev.end);
        let d = new Date(start);
        while (d < end) {
          dates.add(d.toISOString().split('T')[0]);
          d.setDate(d.getDate() + 1);
        }
      }
    } catch (err) {
      console.error('iCal sync error for', url, err.message);
    }
  }
  // Also add confirmed bookings from our own DB
  for (const b of bookings) {
    let d = new Date(b.checkIn);
    const end = new Date(b.checkOut);
    while (d < end) {
      dates.add(d.toISOString().split('T')[0]);
      d.setDate(d.getDate() + 1);
    }
  }
  blockedDates = Array.from(dates);
  console.log(`[iCal] Synced: ${blockedDates.length} blocked dates`);
}

// Sync on startup + every 15 minutes
syncCalendars();
cron.schedule('*/15 * * * *', syncCalendars);

// ═══════════════════════════════════════════════════════════
// GET /blocked-dates — return calendar data to frontend
// ═══════════════════════════════════════════════════════════
app.get('/blocked-dates', (req, res) => {
  res.json({ blockedDates });
});

// ═══════════════════════════════════════════════════════════
// POST /create-payment-intent — charge full stay amount
// ═══════════════════════════════════════════════════════════
app.post('/create-payment-intent', async (req, res) => {
  const { amount, currency, guestName, guestEmail, guestPhone, checkIn, checkOut, nights } = req.body;

  // Validate dates not blocked
  let d = new Date(checkIn);
  const end = new Date(checkOut);
  while (d < end) {
    const s = d.toISOString().split('T')[0];
    if (blockedDates.includes(s)) {
      return res.status(400).json({ error: 'Date ' + s + ' is already booked' });
    }
    d.setDate(d.getDate() + 1);
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,       // in cents
      currency,
      receipt_email: guestEmail,
      metadata: {
        guestName,
        guestEmail,
        guestPhone,
        checkIn,
        checkOut,
        nights: String(nights),
        property: 'Appartement Marseille Centre',
      },
      description: `Séjour ${checkIn} → ${checkOut} — ${guestName}`,
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('PaymentIntent error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /create-deposit-hold — block €100 (manual capture)
// ═══════════════════════════════════════════════════════════
app.post('/create-deposit-hold', async (req, res) => {
  const { paymentIntentId, guestEmail, checkOut } = req.body;

  try {
    // Create a separate PaymentIntent for the €100 hold
    // capture_method: 'manual' means it's authorized but NOT captured (charged)
    const depositIntent = await stripe.paymentIntents.create({
      amount: 10000, // €100 in cents
      currency: 'eur',
      capture_method: 'manual',
      receipt_email: guestEmail,
      metadata: {
        type: 'damage_deposit',
        relatedPaymentIntent: paymentIntentId,
        checkOut,
        guestEmail,
      },
      description: `Caution €100 — Appartement Marseille — checkout ${checkOut}`,
    });

    // Store the hold
    depositHolds.push({
      depositIntentId: depositIntent.id,
      guestEmail,
      checkOut,
      status: 'authorized',
      createdAt: new Date().toISOString(),
    });

    res.json({ depositIntentId: depositIntent.id });
  } catch (err) {
    console.error('Deposit hold error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// STRIPE WEBHOOK — listen for payment success
// ═══════════════════════════════════════════════════════════
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    if (pi.metadata.type !== 'damage_deposit') {
      // This is a stay payment — confirm the booking
      const booking = {
        id: pi.id,
        guestName: pi.metadata.guestName,
        guestEmail: pi.metadata.guestEmail,
        guestPhone: pi.metadata.guestPhone,
        checkIn: pi.metadata.checkIn,
        checkOut: pi.metadata.checkOut,
        nights: parseInt(pi.metadata.nights),
        amount: pi.amount / 100,
        status: 'confirmed',
        confirmedAt: new Date().toISOString(),
      };
      bookings.push(booking);
      console.log(`✅ Booking confirmed: ${booking.guestName} ${booking.checkIn} → ${booking.checkOut}`);

      // TODO: Send confirmation emails here (Resend, SendGrid, etc.)
      // await sendConfirmationEmail(booking);

      // Re-sync calendar to block new dates
      await syncCalendars();
    }
  }

  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════
// OWNER PORTAL API
// ═══════════════════════════════════════════════════════════

// GET /owner/bookings — list all bookings
app.get('/owner/bookings', authenticate, (req, res) => {
  res.json({ bookings: bookings.sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn)) });
});

// GET /owner/deposits — list all active deposit holds
app.get('/owner/deposits', authenticate, (req, res) => {
  res.json({ deposits: depositHolds });
});

// POST /owner/deposits/:id/release — release the €100 hold
app.post('/owner/deposits/:id/release', authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    await stripe.paymentIntents.cancel(id);
    const hold = depositHolds.find(h => h.depositIntentId === id);
    if (hold) hold.status = 'released';
    console.log(`💚 Deposit released: ${id}`);
    res.json({ success: true, message: 'Deposit released' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /owner/deposits/:id/capture — capture (charge) the €100
app.post('/owner/deposits/:id/capture', authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    await stripe.paymentIntents.capture(id);
    const hold = depositHolds.find(h => h.depositIntentId === id);
    if (hold) hold.status = 'captured';
    console.log(`🔴 Deposit captured: ${id}`);
    res.json({ success: true, message: 'Deposit captured — €100 charged to guest' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// AUTO-RELEASE deposits 24h after checkout
// ═══════════════════════════════════════════════════════════
cron.schedule('0 * * * *', async () => {
  const now = new Date();
  for (const hold of depositHolds) {
    if (hold.status !== 'authorized') continue;
    const checkout = new Date(hold.checkOut);
    checkout.setDate(checkout.getDate() + 1); // 24h after checkout
    if (now >= checkout) {
      try {
        await stripe.paymentIntents.cancel(hold.depositIntentId);
        hold.status = 'auto-released';
        console.log(`⏱️ Auto-released deposit for ${hold.guestEmail} (checkout: ${hold.checkOut})`);
      } catch (err) {
        console.error('Auto-release error:', err.message);
      }
    }
  }
});

// ── Simple auth middleware ──
function authenticate(req, res, next) {
  const key = req.headers['x-owner-key'];
  if (key !== process.env.OWNER_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Start ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🏠 Marseille Booking Backend running on port ${PORT}`);
  console.log(`   Stripe mode: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'LIVE 🔴' : 'TEST ✅'}`);
});

// ═══════════════════════════════════════════════════════
// CREATE CHECKOUT SESSION
// ═══════════════════════════════════════════════════════
// When a student books a lesson, this creates a Stripe Checkout
// session that authorizes (but doesn't yet charge) their card.
// The actual charge happens when the coach approves via the webhook.
// ═══════════════════════════════════════════════════════

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Platform fee constants
const COACH_FEE_PCT = 0.08;    // 8% deducted from coach
const STUDENT_FEE_PCT = 0.08;  // 8% added to student

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      coachId,
      studentName,
      studentEmail,
      studentPhone,
      skillLevel,
      bookingDate,
      bookingTime,
      locationId
    } = req.body;

    // Validate required fields
    if (!coachId || !studentName || !studentEmail || !bookingDate || !bookingTime) {
      return res.status(400).json({ error: 'Missing required booking fields' });
    }

    // Fetch coach details
    const { data: coach, error: coachErr } = await supabase
      .from('coaches')
      .select('*')
      .eq('id', coachId)
      .single();

    if (coachErr || !coach) {
      return res.status(404).json({ error: 'Coach not found' });
    }

    if (!coach.stripe_account_id || !coach.stripe_charges_enabled) {
      return res.status(400).json({
        error: 'This coach has not set up payouts yet. Please try a different coach.'
      });
    }

    // Calculate fees (in cents — Stripe uses smallest currency unit)
    const coachPriceCents = Math.round(coach.price * 100);
    const studentFeeCents = Math.round(coachPriceCents * STUDENT_FEE_PCT);
    const totalChargeCents = coachPriceCents + studentFeeCents;
    const coachFeeCents = Math.round(coachPriceCents * COACH_FEE_PCT);
    const platformFeeCents = studentFeeCents + coachFeeCents;
    const coachPayoutCents = totalChargeCents - platformFeeCents;

    // Create the booking record FIRST (status: pending payment auth)
    const { data: booking, error: bookErr } = await supabase
      .from('bookings')
      .insert({
        coach_id: coachId,
        student_name: studentName,
        student_email: studentEmail,
        student_phone: studentPhone,
        skill_level: skillLevel,
        booking_date: bookingDate,
        booking_time: bookingTime,
        location_id: locationId,
        price: coach.price,
        status: 'pending',
        payment_status: 'pending',
        amount_paid: totalChargeCents,
        platform_fee: platformFeeCents,
        coach_payout: coachPayoutCents
      })
      .select()
      .single();

    if (bookErr) {
      console.error('Booking creation error:', bookErr);
      return res.status(500).json({ error: 'Could not create booking' });
    }

    // Build success/cancel URLs
    const origin = req.headers.origin || 'https://swingablegolf.com';
    const successUrl = `${origin}/booking-success.html?session_id={CHECKOUT_SESSION_ID}&booking_id=${booking.id}`;
    const cancelUrl = `${origin}/?booking_cancelled=true`;

    // Create Stripe Checkout session with manual capture
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: studentEmail,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Golf Lesson with ${coach.first_name} ${coach.last_name}`,
              description: `${bookingDate} at ${bookingTime}`,
            },
            unit_amount: coachPriceCents,
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Service fee',
              description: 'Swingable Golf platform fee (8%)',
            },
            unit_amount: studentFeeCents,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        capture_method: 'manual',  // <-- KEY: authorize only, don't capture yet
        application_fee_amount: platformFeeCents,
        transfer_data: {
          destination: coach.stripe_account_id,
        },
        metadata: {
          booking_id: booking.id,
          coach_id: coachId,
          student_email: studentEmail,
        },
      },
      metadata: {
        booking_id: booking.id,
        coach_id: coachId,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
      expires_at: Math.floor(Date.now() / 1000) + (30 * 60),  // 30 min expiry
    });

    // Save the session ID to the booking
    await supabase
      .from('bookings')
      .update({
        stripe_session_id: session.id,
        stripe_payment_intent_id: session.payment_intent
      })
      .eq('id', booking.id);

    return res.status(200).json({
      sessionId: session.id,
      url: session.url,
      bookingId: booking.id
    });

  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).json({
      error: 'Something went wrong creating your booking. Please try again.'
    });
  }
}

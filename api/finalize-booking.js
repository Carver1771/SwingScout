// ═══════════════════════════════════════════════════════
// FINALIZE BOOKING — POST-PAYMENT SYNC + EMAILS
// ═══════════════════════════════════════════════════════
// Called from booking-success.html when a student lands there
// after completing Stripe Checkout. This is our reliable path
// for finalizing the booking and sending notification emails,
// independent of the webhook (which doesn't always fire on
// newer Stripe API versions).
//
// Idempotent: safe to call multiple times. Only sends emails
// once per booking by checking payment_status before acting.
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { sessionId, bookingId } = req.body;

    if (!sessionId && !bookingId) {
      return res.status(400).json({ error: 'Missing sessionId or bookingId' });
    }

    // Find the booking by either id or session_id
    let bookingQuery = supabase
      .from('bookings')
      .select('*, coaches(*), locations(*)');

    if (bookingId) {
      bookingQuery = bookingQuery.eq('id', bookingId);
    } else {
      bookingQuery = bookingQuery.eq('stripe_session_id', sessionId);
    }

    const { data: booking, error: bookErr } = await bookingQuery.single();

    if (bookErr || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Idempotency check — if already authorized or paid, just return success
    if (booking.payment_status === 'authorized' ||
        booking.payment_status === 'paid' ||
        booking.payment_status === 'refunded') {
      return res.status(200).json({
        success: true,
        alreadyFinalized: true,
        bookingId: booking.id,
      });
    }

    // Sync payment_intent_id from Stripe if missing
    let paymentIntentId = booking.stripe_payment_intent_id;
    if (!paymentIntentId && booking.stripe_session_id) {
      try {
        const session = await stripe.checkout.sessions.retrieve(
          booking.stripe_session_id
        );
        paymentIntentId = session.payment_intent;
      } catch (sessionErr) {
        console.error('Could not retrieve session:', sessionErr);
      }
    }

    // Update booking status to authorized
    await supabase
      .from('bookings')
      .update({
        payment_status: 'authorized',
        stripe_payment_intent_id: paymentIntentId || null,
      })
      .eq('id', booking.id);

    // Send notification emails
    const dateStr = new Date(booking.booking_date + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });

    const emailPayload = {
      type: 'booking',
      data: {
        studentName: booking.student_name,
        studentEmail: booking.student_email,
        studentPhone: booking.student_phone,
        skillLevel: booking.skill_level,
        coachName: `${booking.coaches.first_name} ${booking.coaches.last_name}`,
        coachEmail: booking.coaches.email,
        location: booking.locations?.name || 'TBD',
        date: dateStr,
        time: booking.booking_time,
        price: `$${booking.price}/hr`,
        studentToken: booking.student_token,
        lessonInstructions: getLessonInstructions(booking),
      },
    };

    // Send notification emails — MUST await so serverless function
    // doesn't terminate before the request completes
    try {
      await fetch(`${process.env.SITE_URL || 'https://swingablegolf.com'}/api/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(emailPayload),
      });
    } catch (emailErr) {
      console.error('Email send failed:', emailErr);
    }

    return res.status(200).json({
      success: true,
      bookingId: booking.id,
      finalized: true,
    });

  } catch (err) {
    console.error('Finalize booking error:', err);
    return res.status(500).json({
      error: err.message || 'Could not finalize booking'
    });
  }
}

// Compute combined lesson instructions: location default + coach-specific override
function getLessonInstructions(booking) {
  const coach = booking.coaches || {};
  const location = booking.locations;
  const coachInstructions = coach.location_instructions || {};

  // Coach's note for this specific location (or 'custom' for non-listed venues)
  let coachNote = '';
  if (booking.location_id && coachInstructions[booking.location_id]) {
    coachNote = coachInstructions[booking.location_id];
  } else if (!booking.location_id && coachInstructions.custom) {
    coachNote = coachInstructions.custom;
  }

  // Location default (admin-set)
  const locationDefault = location?.default_instructions || '';

  // Combine: location default first, then coach's specific note
  const parts = [];
  if (locationDefault) parts.push(locationDefault);
  if (coachNote) parts.push(coachNote);
  return parts.join('\n\n');
}

// ═══════════════════════════════════════════════════════
// APPROVE BOOKING (CAPTURE PAYMENT)
// ═══════════════════════════════════════════════════════
// When a coach approves a pending booking, this captures
// the payment authorization (actually charges the card)
// and triggers the transfer to the coach's connected account.
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
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({ error: 'Missing bookingId' });
    }

    // Fetch the booking
    const { data: booking, error: bookErr } = await supabase
      .from('bookings')
      .select('*, coaches(*), locations(*)')
      .eq('id', bookingId)
      .single();

    if (bookErr || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.payment_status === 'paid') {
      return res.status(400).json({ error: 'Already approved and paid' });
    }

    if (!booking.stripe_payment_intent_id) {
      return res.status(400).json({ error: 'No payment to capture' });
    }

    // Verify the payment intent is in 'requires_capture' state
    const paymentIntent = await stripe.paymentIntents.retrieve(
      booking.stripe_payment_intent_id
    );

    if (paymentIntent.status !== 'requires_capture') {
      return res.status(400).json({
        error: `Cannot approve: payment is in state '${paymentIntent.status}'. It may have expired or been canceled.`
      });
    }

    // CAPTURE the payment — this actually charges the card
    const captured = await stripe.paymentIntents.capture(
      booking.stripe_payment_intent_id
    );

    // Update the booking
    await supabase
      .from('bookings')
      .update({
        status: 'confirmed',
        payment_status: 'paid',
        paid_at: new Date().toISOString(),
      })
      .eq('id', bookingId);

    // Send confirmation email to student
    const dateStr = new Date(booking.booking_date + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });

    fetch(`${process.env.SITE_URL || 'https://swingablegolf.com'}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'booking_confirmed',
        data: {
          studentName: booking.student_name,
          studentEmail: booking.student_email,
          coachName: `${booking.coaches.first_name} ${booking.coaches.last_name}`,
          date: dateStr,
          time: booking.booking_time,
          location: booking.locations?.name || 'TBD',
        },
      }),
    }).catch(e => console.error('Email send failed:', e));

    return res.status(200).json({
      success: true,
      bookingId,
      paymentIntent: captured.id,
    });

  } catch (err) {
    console.error('Approve booking error:', err);
    return res.status(500).json({
      error: err.message || 'Could not approve booking'
    });
  }
}

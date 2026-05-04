// ═══════════════════════════════════════════════════════
// CANCEL/REFUND BOOKING
// ═══════════════════════════════════════════════════════
// Handles two cases:
// 1. Authorization not yet captured → release the auth (no charge)
// 2. Already paid → issue a full or partial refund
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
    const { bookingId, reason } = req.body;

    if (!bookingId) {
      return res.status(400).json({ error: 'Missing bookingId' });
    }

    // Fetch the booking
    const { data: booking, error: bookErr } = await supabase
      .from('bookings')
      .select('*, coaches(*)')
      .eq('id', bookingId)
      .single();

    if (bookErr || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.payment_status === 'refunded') {
      return res.status(400).json({ error: 'Already refunded' });
    }

    if (!booking.stripe_payment_intent_id) {
      // No payment was ever attached — just mark as cancelled
      await supabase
        .from('bookings')
        .update({ status: 'cancelled', payment_status: 'cancelled' })
        .eq('id', bookingId);
      return res.status(200).json({ success: true, action: 'cancelled' });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(
      booking.stripe_payment_intent_id
    );

    let action;

    // Case 1: Auth not captured yet → cancel/release the authorization
    if (paymentIntent.status === 'requires_capture') {
      await stripe.paymentIntents.cancel(booking.stripe_payment_intent_id, {
        cancellation_reason: 'requested_by_customer',
      });
      action = 'authorization_released';

      await supabase
        .from('bookings')
        .update({
          status: 'cancelled',
          payment_status: 'cancelled',
        })
        .eq('id', bookingId);

    // Case 2: Already captured → issue a refund
    } else if (paymentIntent.status === 'succeeded') {
      const refund = await stripe.refunds.create({
        payment_intent: booking.stripe_payment_intent_id,
        reason: reason || 'requested_by_customer',
        reverse_transfer: true,         // Pull funds back from coach
        refund_application_fee: true,   // Refund the platform fee too
        metadata: {
          booking_id: bookingId,
        },
      });
      action = 'refunded';

      await supabase
        .from('bookings')
        .update({
          status: 'cancelled',
          payment_status: 'refunded',
          refunded: true,
          refund_id: refund.id,
          refunded_at: new Date().toISOString(),
        })
        .eq('id', bookingId);

    } else {
      return res.status(400).json({
        error: `Cannot cancel: payment in state '${paymentIntent.status}'`
      });
    }

    // Notify student of cancellation
    fetch(`${process.env.SITE_URL || 'https://swingablegolf.com'}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: action === 'refunded' ? 'booking_refunded' : 'booking_declined',
        data: {
          studentName: booking.student_name,
          studentEmail: booking.student_email,
          coachName: `${booking.coaches.first_name} ${booking.coaches.last_name}`,
          date: booking.booking_date,
          time: booking.booking_time,
          amount: booking.amount_paid ? `$${(booking.amount_paid / 100).toFixed(2)}` : null,
        },
      }),
    }).catch(e => console.error('Email send failed:', e));

    return res.status(200).json({ success: true, action });

  } catch (err) {
    console.error('Cancel/refund error:', err);
    return res.status(500).json({
      error: err.message || 'Could not process cancellation'
    });
  }
}

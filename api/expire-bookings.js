// ═══════════════════════════════════════════════════════
// EXPIRE STALE BOOKINGS
// ═══════════════════════════════════════════════════════
// Sweeps bookings that have been authorized but not approved
// within 24 hours. Stripe auto-releases the authorization on
// their side at 24h, so we sync our database and notify both
// parties.
//
// Called from:
//   - coach.html on page load (passive sweep)
//   - check-coach-status.js (incidental sweep)
//   - Could also be called by a cron job in the future
//
// Idempotent and lightweight — safe to call frequently.
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

const EXPIRY_HOURS = 24;

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const cutoff = new Date(Date.now() - EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

    // Find pending+authorized bookings older than 24 hours
    const { data: stale, error } = await supabase
      .from('bookings')
      .select('*, coaches(first_name, last_name, email)')
      .eq('status', 'pending')
      .eq('payment_status', 'authorized')
      .lt('created_at', cutoff);

    if (error) {
      console.error('Stale booking query error:', error);
      return res.status(500).json({ error: 'Could not check stale bookings' });
    }

    if (!stale || stale.length === 0) {
      return res.status(200).json({ expired: 0 });
    }

    let expired = 0;
    const errors = [];

    for (const booking of stale) {
      try {
        // Try to cancel the payment intent (Stripe likely already auto-released)
        if (booking.stripe_payment_intent_id) {
          try {
            const intent = await stripe.paymentIntents.retrieve(
              booking.stripe_payment_intent_id
            );
            if (intent.status === 'requires_capture') {
              await stripe.paymentIntents.cancel(
                booking.stripe_payment_intent_id,
                { cancellation_reason: 'abandoned' }
              );
            }
          } catch (stripeErr) {
            // Stripe errors here are non-fatal — auth was likely already released
            console.warn('Stripe cancel skipped:', stripeErr.message);
          }
        }

        // Update database
        await supabase
          .from('bookings')
          .update({
            status: 'cancelled',
            payment_status: 'cancelled',
            cancelled_at: new Date().toISOString(),
            cancelled_by: 'system_auth_expired',
            expired_at: new Date().toISOString(),
          })
          .eq('id', booking.id);

        // Notify student that auth expired (no charge made)
        try {
          await fetch(`${process.env.SITE_URL || 'https://swingablegolf.com'}/api/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'booking_declined',
              data: {
                studentName: booking.student_name,
                studentEmail: booking.student_email,
                coachName: `${booking.coaches.first_name} ${booking.coaches.last_name}`,
                coachEmail: booking.coaches.email,
                date: booking.booking_date,
                time: booking.booking_time,
              },
            }),
          });
        } catch (emailErr) {
          console.error('Expiry email failed:', emailErr);
        }

        expired++;
      } catch (err) {
        console.error(`Could not expire booking ${booking.id}:`, err);
        errors.push({ id: booking.id, error: err.message });
      }
    }

    return res.status(200).json({
      expired,
      total_stale: stale.length,
      errors: errors.length ? errors : undefined,
    });

  } catch (err) {
    console.error('Expire bookings error:', err);
    return res.status(500).json({ error: err.message });
  }
}

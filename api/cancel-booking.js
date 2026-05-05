// ═══════════════════════════════════════════════════════
// CANCEL/REFUND BOOKING — WITH REFUND POLICY
// ═══════════════════════════════════════════════════════
// Handles cancellations from either student or coach with
// the refund policy:
//   - Coach cancels: ALWAYS full refund regardless of timing
//   - Student cancels >24h before lesson: full refund
//   - Student cancels <24h before lesson: NO refund
//   - Pending booking (any party): release auth, no charge
//
// Self-healing for missing payment metadata + handles all
// edge cases (already canceled, already captured, etc.)
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

const REFUND_CUTOFF_HOURS = 24;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { bookingId, reason, studentToken, cancelledBy } = req.body;

    if (!bookingId) {
      return res.status(400).json({ error: 'Missing bookingId' });
    }

    const { data: booking, error: bookErr } = await supabase
      .from('bookings')
      .select('*, coaches(*)')
      .eq('id', bookingId)
      .single();

    if (bookErr || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.payment_status === 'refunded' || booking.status === 'cancelled') {
      return res.status(400).json({ error: 'Already cancelled or refunded' });
    }

    // ─── AUTH: if student-initiated, validate token ───
    const isStudentInitiated = cancelledBy === 'student';
    if (isStudentInitiated) {
      if (!studentToken || booking.student_token !== studentToken) {
        return res.status(403).json({ error: 'Invalid token' });
      }
    }

    // ─── REFUND POLICY DETERMINATION ───
    const cancellerType = cancelledBy || 'coach'; // default to coach for backwards compat
    const isPendingApproval = booking.status === 'pending';
    const lessonDateTime = new Date(booking.booking_date + 'T' + convertTimeTo24h(booking.booking_time));
    const hoursUntilLesson = (lessonDateTime - Date.now()) / (1000 * 60 * 60);

    let shouldRefund;
    if (isPendingApproval) {
      // Pending → no charge to refund, just release auth
      shouldRefund = true; // (technically we just cancel, not refund)
    } else if (cancellerType === 'coach') {
      // Coach cancels confirmed lesson → ALWAYS full refund
      shouldRefund = true;
    } else if (cancellerType === 'student' && hoursUntilLesson > REFUND_CUTOFF_HOURS) {
      // Student cancels with 24+ hours notice → full refund
      shouldRefund = true;
    } else {
      // Student cancels within 24 hours of lesson → NO refund (coach keeps payout)
      shouldRefund = false;
    }

    // ─── SELF-HEALING: Recover payment_intent_id if missing ───
    let paymentIntentId = booking.stripe_payment_intent_id;

    if (!paymentIntentId && booking.stripe_session_id) {
      try {
        const session = await stripe.checkout.sessions.retrieve(booking.stripe_session_id);
        paymentIntentId = session.payment_intent;
        if (paymentIntentId) {
          await supabase
            .from('bookings')
            .update({ stripe_payment_intent_id: paymentIntentId })
            .eq('id', bookingId);
        }
      } catch (sessionErr) {
        console.error('Could not retrieve session:', sessionErr);
      }
    }

    // No payment was ever attached — just mark as cancelled
    if (!paymentIntentId) {
      await supabase
        .from('bookings')
        .update({
          status: 'cancelled',
          payment_status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          cancelled_by: cancellerType,
        })
        .eq('id', bookingId);

      await sendCancellationEmails(booking, 'cancelled', cancellerType, false);
      return res.status(200).json({ success: true, action: 'cancelled', refunded: false });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    let action;
    let refunded = false;

    // CASE 1: Auth not yet captured (still pending) → release/cancel
    if (paymentIntent.status === 'requires_capture' || paymentIntent.status === 'requires_payment_method') {
      try {
        await stripe.paymentIntents.cancel(paymentIntentId, {
          cancellation_reason: 'requested_by_customer',
        });
      } catch (cancelErr) {
        if (!cancelErr.message?.includes('already')) throw cancelErr;
      }
      action = 'authorization_released';

      await supabase
        .from('bookings')
        .update({
          status: 'cancelled',
          payment_status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          cancelled_by: cancellerType,
        })
        .eq('id', bookingId);

    // CASE 2: Already captured (paid) — refund or not based on policy
    } else if (paymentIntent.status === 'succeeded') {
      if (shouldRefund) {
        const refund = await stripe.refunds.create({
          payment_intent: paymentIntentId,
          reason: 'requested_by_customer', // Stripe only accepts: duplicate, fraudulent, requested_by_customer
          reverse_transfer: true,
          refund_application_fee: true,
          metadata: {
            booking_id: bookingId,
            cancelled_by: cancellerType,
            internal_reason: reason || 'cancellation',
          },
        });
        action = 'refunded';
        refunded = true;

        await supabase
          .from('bookings')
          .update({
            status: 'cancelled',
            payment_status: 'refunded',
            refunded: true,
            refund_id: refund.id,
            refunded_at: new Date().toISOString(),
            cancelled_at: new Date().toISOString(),
            cancelled_by: cancellerType,
          })
          .eq('id', bookingId);
      } else {
        // Cancel without refund (student inside 24h window)
        action = 'cancelled_no_refund';

        await supabase
          .from('bookings')
          .update({
            status: 'cancelled',
            payment_status: 'paid', // money stays with coach
            cancelled_at: new Date().toISOString(),
            cancelled_by: cancellerType,
          })
          .eq('id', bookingId);
      }

    } else if (paymentIntent.status === 'canceled') {
      // Already canceled in Stripe — sync DB
      await supabase
        .from('bookings')
        .update({
          status: 'cancelled',
          payment_status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          cancelled_by: cancellerType,
        })
        .eq('id', bookingId);
      action = 'authorization_released';

    } else {
      return res.status(400).json({
        error: `Cannot cancel: payment in state '${paymentIntent.status}'`
      });
    }

    await sendCancellationEmails(booking, action, cancellerType, refunded);

    return res.status(200).json({ success: true, action, refunded });

  } catch (err) {
    console.error('Cancel/refund error:', err);
    return res.status(500).json({
      error: err.message || 'Could not process cancellation'
    });
  }
}

async function sendCancellationEmails(booking, action, cancellerType, refunded) {
  const dateStr = new Date(booking.booking_date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  const emailType = refunded ? 'booking_refunded' : 'booking_declined';

  try {
    await fetch(`${process.env.SITE_URL || 'https://swingablegolf.com'}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: emailType,
        data: {
          studentName: booking.student_name,
          studentEmail: booking.student_email,
          coachName: `${booking.coaches.first_name} ${booking.coaches.last_name}`,
          coachEmail: booking.coaches.email,
          date: dateStr,
          time: booking.booking_time,
          amount: booking.amount_paid ? `$${(booking.amount_paid / 100).toFixed(2)}` : null,
          cancelledBy: cancellerType,
        },
      }),
    });
  } catch (e) {
    console.error('Cancellation email failed:', e);
  }
}

// Convert "2:00 PM" format to "14:00" for Date parsing
function convertTimeTo24h(timeStr) {
  if (!timeStr) return '12:00';
  const cleaned = timeStr.trim();

  // Already 24h format
  if (/^\d{1,2}:\d{2}$/.test(cleaned)) return cleaned.padStart(5, '0');

  // Match "1:30 PM" or "1 PM" etc
  const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!match) return '12:00';

  let h = parseInt(match[1], 10);
  const m = match[2] ? parseInt(match[2], 10) : 0;
  const period = match[3].toLowerCase();

  if (period === 'pm' && h !== 12) h += 12;
  if (period === 'am' && h === 12) h = 0;

  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// ═══════════════════════════════════════════════════════
// STRIPE WEBHOOK HANDLER
// ═══════════════════════════════════════════════════════
// Stripe calls this endpoint whenever something happens:
// - Payment authorized (after student completes checkout)
// - Payment captured (after coach approves)
// - Payment refunded
// - Coach Connect account updated
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

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Vercel needs raw body for webhook signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};

// Helper: read the raw request body
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let event;

  try {
    const rawBody = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Log every event for audit trail
  try {
    await supabase.from('payments').insert({
      stripe_payment_intent_id: event.data?.object?.payment_intent || null,
      stripe_session_id: event.data?.object?.id || null,
      event_type: event.type,
      status: event.data?.object?.status || 'unknown',
      amount: event.data?.object?.amount_total || event.data?.object?.amount || null,
      raw_event: event,
    });
  } catch (logErr) {
    console.error('Payment log error (non-fatal):', logErr);
  }

  try {
    switch (event.type) {

      // ─── CHECKOUT COMPLETED — payment authorized, awaiting coach approval ───
      case 'checkout.session.completed': {
        const session = event.data.object;
        const bookingId = session.metadata?.booking_id;

        if (!bookingId) break;

        await supabase
          .from('bookings')
          .update({
            payment_status: 'authorized',
            stripe_payment_intent_id: session.payment_intent,
            stripe_session_id: session.id,
          })
          .eq('id', bookingId);

        // Notify coach about new booking request
        const { data: booking } = await supabase
          .from('bookings')
          .select('*, coaches(*), locations(*)')
          .eq('id', bookingId)
          .single();

        if (booking?.coaches) {
          fetch(`${process.env.SITE_URL || 'https://swingablegolf.com'}/api/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'booking',
              data: {
                studentName: booking.student_name,
                studentEmail: booking.student_email,
                studentPhone: booking.student_phone,
                skillLevel: booking.skill_level,
                coachName: `${booking.coaches.first_name} ${booking.coaches.last_name}`,
                coachEmail: booking.coaches.email,
                location: booking.locations?.name || 'TBD',
                date: booking.booking_date,
                time: booking.booking_time,
                price: `$${booking.price}/hr`,
              },
            }),
          }).catch(e => console.error('Email send failed:', e));
        }
        break;
      }

      // ─── PAYMENT CAPTURED — coach approved, money actually charged ───
      case 'payment_intent.amount_capturable_updated':
      case 'payment_intent.succeeded': {
        const intent = event.data.object;
        const bookingId = intent.metadata?.booking_id;

        if (!bookingId) break;

        const isCaptured = intent.status === 'succeeded';

        await supabase
          .from('bookings')
          .update({
            payment_status: isCaptured ? 'paid' : 'authorized',
            paid_at: isCaptured ? new Date().toISOString() : null,
            stripe_transfer_id: intent.transfer_data?.destination || null,
          })
          .eq('id', bookingId);
        break;
      }

      // ─── PAYMENT FAILED ───
      case 'payment_intent.payment_failed': {
        const intent = event.data.object;
        const bookingId = intent.metadata?.booking_id;

        if (!bookingId) break;

        await supabase
          .from('bookings')
          .update({
            payment_status: 'failed',
            status: 'cancelled',
          })
          .eq('id', bookingId);
        break;
      }

      // ─── PAYMENT CANCELED — auth expired or manually voided ───
      case 'payment_intent.canceled': {
        const intent = event.data.object;
        const bookingId = intent.metadata?.booking_id;

        if (!bookingId) break;

        await supabase
          .from('bookings')
          .update({
            payment_status: 'failed',
            status: 'cancelled',
          })
          .eq('id', bookingId);
        break;
      }

      // ─── REFUND ISSUED ───
      case 'charge.refunded': {
        const charge = event.data.object;
        const bookingId = charge.metadata?.booking_id ||
                         charge.payment_intent && (await stripe.paymentIntents.retrieve(charge.payment_intent)).metadata?.booking_id;

        if (!bookingId) break;

        await supabase
          .from('bookings')
          .update({
            payment_status: 'refunded',
            refunded: true,
            refund_id: charge.refunds?.data?.[0]?.id || null,
            refunded_at: new Date().toISOString(),
            status: 'cancelled',
          })
          .eq('id', bookingId);
        break;
      }

      // ─── COACH STRIPE CONNECT ACCOUNT UPDATED ───
      case 'account.updated': {
        const account = event.data.object;

        await supabase
          .from('coaches')
          .update({
            stripe_charges_enabled: account.charges_enabled || false,
            stripe_payouts_enabled: account.payouts_enabled || false,
            stripe_onboarding_complete: account.details_submitted || false,
          })
          .eq('stripe_account_id', account.id);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}

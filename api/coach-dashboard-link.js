// ═══════════════════════════════════════════════════════
// COACH DASHBOARD LINK
// ═══════════════════════════════════════════════════════
// Generates a one-time login link to the Stripe Express
// hosted dashboard. Coaches can:
//   - View earnings (lifetime, this month, etc.)
//   - Update bank account
//   - Download tax forms (1099-K)
//   - See payout schedule
//
// Each call generates a fresh single-use link (Stripe security).
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
    const { coachId } = req.body;
    if (!coachId) return res.status(400).json({ error: 'Missing coachId' });

    const { data: coach, error: coachErr } = await supabase
      .from('coaches')
      .select('stripe_account_id, stripe_charges_enabled')
      .eq('id', coachId)
      .single();

    if (coachErr || !coach) {
      return res.status(404).json({ error: 'Coach not found' });
    }

    if (!coach.stripe_account_id) {
      return res.status(400).json({ error: 'No Stripe account connected' });
    }

    if (!coach.stripe_charges_enabled) {
      return res.status(400).json({
        error: 'Your Stripe account is still being verified. Try again in a few minutes.'
      });
    }

    // Generate a fresh login link to Stripe Express dashboard
    const loginLink = await stripe.accounts.createLoginLink(coach.stripe_account_id);

    return res.status(200).json({ url: loginLink.url });

  } catch (err) {
    console.error('Stripe dashboard link error:', err);
    return res.status(500).json({
      error: err.message || 'Could not generate dashboard link'
    });
  }
}

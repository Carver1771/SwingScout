// ═══════════════════════════════════════════════════════
// COACH STRIPE HELPERS (merged endpoint)
// ═══════════════════════════════════════════════════════
// Single endpoint that handles two related Stripe operations
// for a coach. Dispatched by the `action` field in the body:
//
//   action: 'check_status'
//     Queries Stripe directly for latest account status and
//     syncs to Supabase. Self-healing — replaces unreliable
//     account.updated webhook on newer Stripe API versions.
//     Called on return from Stripe onboarding and on coach.html
//     load when the coach has stripe_account_id but isn't yet
//     fully enabled.
//
//   action: 'dashboard_link'
//     Generates a one-time login URL to the Stripe Express
//     hosted dashboard. Coaches view earnings, update bank
//     info, and download 1099-K tax forms there.
//
// Previously split into two files. Merged to stay under the
// Vercel Hobby 12-function limit.
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
    const { action, coachId } = req.body;

    if (!coachId) return res.status(400).json({ error: 'Missing coachId' });
    if (!action)  return res.status(400).json({ error: 'Missing action' });

    if (action === 'check_status') {
      return await checkStatus(coachId, res);
    }
    if (action === 'dashboard_link') {
      return await dashboardLink(coachId, res);
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('Coach Stripe handler error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}

// ─── action: check_status ───
async function checkStatus(coachId, res) {
  const { data: coach, error: fetchErr } = await supabase
    .from('coaches')
    .select('id, stripe_account_id, stripe_charges_enabled')
    .eq('id', coachId)
    .single();

  if (fetchErr || !coach) {
    return res.status(404).json({ error: 'Coach not found' });
  }

  if (!coach.stripe_account_id) {
    return res.status(200).json({
      synced: false,
      reason: 'no_stripe_account',
      charges_enabled: false,
      payouts_enabled: false,
      onboarding_complete: false,
    });
  }

  const account = await stripe.accounts.retrieve(coach.stripe_account_id);

  const newStatus = {
    stripe_charges_enabled: account.charges_enabled || false,
    stripe_payouts_enabled: account.payouts_enabled || false,
    stripe_onboarding_complete: account.details_submitted || false,
  };

  const { error: updateErr } = await supabase
    .from('coaches')
    .update(newStatus)
    .eq('id', coachId);

  if (updateErr) {
    console.error('Coach update error:', updateErr);
    return res.status(500).json({ error: 'Could not update coach' });
  }

  return res.status(200).json({
    synced: true,
    charges_enabled: newStatus.stripe_charges_enabled,
    payouts_enabled: newStatus.stripe_payouts_enabled,
    onboarding_complete: newStatus.stripe_onboarding_complete,
  });
}

// ─── action: dashboard_link ───
async function dashboardLink(coachId, res) {
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

  const loginLink = await stripe.accounts.createLoginLink(coach.stripe_account_id);

  return res.status(200).json({ url: loginLink.url });
}

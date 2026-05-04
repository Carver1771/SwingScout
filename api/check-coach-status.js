// ═══════════════════════════════════════════════════════
// CHECK COACH STRIPE STATUS
// ═══════════════════════════════════════════════════════
// Queries Stripe directly for the latest account status and
// syncs it to Supabase. Used as the primary mechanism to keep
// coach payment-readiness in sync (replaces webhook dependency
// for account.updated events, which don't fire reliably on
// newer Stripe API versions).
//
// Called from coach.html:
//   - On return from Stripe onboarding (?stripe_complete=true)
//   - On every page load if coach has stripe_account_id but
//     stripe_charges_enabled is false (self-healing failsafe)
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

    if (!coachId) {
      return res.status(400).json({ error: 'Missing coachId' });
    }

    // Fetch the coach record
    const { data: coach, error: fetchErr } = await supabase
      .from('coaches')
      .select('id, stripe_account_id, stripe_charges_enabled')
      .eq('id', coachId)
      .single();

    if (fetchErr || !coach) {
      return res.status(404).json({ error: 'Coach not found' });
    }

    // No Stripe account yet — nothing to sync
    if (!coach.stripe_account_id) {
      return res.status(200).json({
        synced: false,
        reason: 'no_stripe_account',
        charges_enabled: false,
        payouts_enabled: false,
        onboarding_complete: false,
      });
    }

    // Query Stripe for the live account state
    const account = await stripe.accounts.retrieve(coach.stripe_account_id);

    const newStatus = {
      stripe_charges_enabled: account.charges_enabled || false,
      stripe_payouts_enabled: account.payouts_enabled || false,
      stripe_onboarding_complete: account.details_submitted || false,
    };

    // Update Supabase to match Stripe's truth
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

  } catch (err) {
    console.error('Check coach status error:', err);
    return res.status(500).json({
      error: err.message || 'Could not sync coach status'
    });
  }
}

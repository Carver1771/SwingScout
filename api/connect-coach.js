// ═══════════════════════════════════════════════════════
// CONNECT COACH TO STRIPE
// ═══════════════════════════════════════════════════════
// Creates a Stripe Connect account for a coach and returns
// an onboarding URL where they enter their bank/identity info.
// Coach can't receive payments until they complete this.
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

    // Fetch the coach
    const { data: coach, error: coachErr } = await supabase
      .from('coaches')
      .select('*')
      .eq('id', coachId)
      .single();

    if (coachErr || !coach) {
      return res.status(404).json({ error: 'Coach not found' });
    }

    let stripeAccountId = coach.stripe_account_id;

    // Create the Connect account if one doesn't exist yet
    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'US',
        email: coach.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: 'individual',
        business_profile: {
          mcc: '7997',  // Country/recreation clubs
          product_description: 'Golf coaching and lesson services',
          url: 'https://swingablegolf.com',
        },
        metadata: {
          coach_id: coachId,
          coach_name: `${coach.first_name} ${coach.last_name}`,
        },
      });

      stripeAccountId = account.id;

      await supabase
        .from('coaches')
        .update({
          stripe_account_id: stripeAccountId,
          stripe_account_created_at: new Date().toISOString(),
        })
        .eq('id', coachId);
    }

    // Generate onboarding link (where coach enters their info)
    const origin = req.headers.origin || 'https://swingablegolf.com';
    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${origin}/coach.html?stripe_refresh=true`,
      return_url: `${origin}/coach.html?stripe_complete=true`,
      type: 'account_onboarding',
    });

    return res.status(200).json({
      url: accountLink.url,
      accountId: stripeAccountId,
    });

  } catch (err) {
    console.error('Connect onboarding error:', err);
    return res.status(500).json({
      error: err.message || 'Could not create Stripe onboarding link'
    });
  }
}

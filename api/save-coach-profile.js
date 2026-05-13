// ═══════════════════════════════════════════════════════
// SAVE COACH PROFILE
// ═══════════════════════════════════════════════════════
// Server-side validation + write for coach profile edits.
// Replaces direct client→Supabase writes from coach.html.
//
// Auth: requires a Supabase JWT in the Authorization header.
// The coach record updated is determined by the JWT's user_id,
// NOT by anything in the request body. A coach can only update
// their own profile.
// ═══════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Validation rules ───
const PRICE_MIN = 25;
const PRICE_MAX = 500;
const YEARS_MAX = 70;

// Field length limits — generous but bounded
const LIMITS = {
  first_name: 50,
  last_name: 50,
  phone: 30,
  instagram: 100,
  website: 200,
  linkedin: 200,
  certifications: 1000,
  achievements: 1000,
  custom_facility_name: 150,
  custom_facility_address: 300,
  short_bio: 300,
  full_bio: 3000,
  instructions: 500,        // per-location instructions
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ─── 1. Authenticate the request ───
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      return res.status(401).json({ error: 'Missing authentication' });
    }

    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    // ─── 2. Find the coach record for this user ───
    const { data: coach, error: coachErr } = await supabase
      .from('coaches')
      .select('id, location_instructions')
      .eq('user_id', user.id)
      .single();

    if (coachErr || !coach) {
      return res.status(404).json({ error: 'No coach profile found for this user' });
    }

    // ─── 3. Pull fields from the request body ───
    const body = req.body || {};
    const {
      first_name, last_name, phone, instagram, website, linkedin,
      certifications, achievements, price, location_id,
      custom_facility_name, custom_facility_address, location_instructions_for_key,
      location_instructions_key, short_bio, full_bio,
      pga_certified, years_experience, specialties
    } = body;

    // ─── 4. Validate ───

    // Required: first_name, last_name
    if (typeof first_name !== 'string' || !first_name.trim()) {
      return res.status(400).json({ error: 'First name is required' });
    }
    if (typeof last_name !== 'string' || !last_name.trim()) {
      return res.status(400).json({ error: 'Last name is required' });
    }

    // String length checks
    const stringFields = {
      first_name, last_name, phone, instagram, website, linkedin,
      certifications, achievements, custom_facility_name,
      custom_facility_address, short_bio, full_bio
    };
    for (const [name, value] of Object.entries(stringFields)) {
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') {
        return res.status(400).json({ error: `Invalid type for ${name}` });
      }
      const limit = LIMITS[name];
      if (limit && value.length > limit) {
        return res.status(400).json({ error: `${prettyName(name)} is too long (max ${limit} characters)` });
      }
    }

    // Price: must be a number, integer, within bounds
    if (price === undefined || price === null || price === '') {
      return res.status(400).json({ error: 'Price is required' });
    }
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || !Number.isInteger(priceNum)) {
      return res.status(400).json({ error: 'Price must be a whole number' });
    }
    if (priceNum < PRICE_MIN || priceNum > PRICE_MAX) {
      return res.status(400).json({ error: `Price must be between $${PRICE_MIN} and $${PRICE_MAX}` });
    }

    // Years experience: optional, but if present must be 0–70
    let yearsNum = 0;
    if (years_experience !== undefined && years_experience !== null && years_experience !== '') {
      yearsNum = Number(years_experience);
      if (!Number.isFinite(yearsNum) || !Number.isInteger(yearsNum)) {
        return res.status(400).json({ error: 'Years of experience must be a whole number' });
      }
      if (yearsNum < 0 || yearsNum > YEARS_MAX) {
        return res.status(400).json({ error: `Years of experience must be between 0 and ${YEARS_MAX}` });
      }
    }

    // pga_certified: must be boolean if present
    let pgaCert = false;
    if (pga_certified !== undefined && pga_certified !== null) {
      if (typeof pga_certified !== 'boolean') {
        return res.status(400).json({ error: 'PGA certified must be true or false' });
      }
      pgaCert = pga_certified;
    }

    // specialties: optional array of short strings
    let specs = [];
    if (specialties !== undefined && specialties !== null) {
      if (!Array.isArray(specialties)) {
        return res.status(400).json({ error: 'Specialties must be a list' });
      }
      if (specialties.length > 20) {
        return res.status(400).json({ error: 'Too many specialties (max 20)' });
      }
      for (const s of specialties) {
        if (typeof s !== 'string' || s.length > 80) {
          return res.status(400).json({ error: 'Each specialty must be a string under 80 characters' });
        }
      }
      specs = specialties.map(s => s.trim()).filter(Boolean);
    }

    // location_id: optional, must be a string UUID-ish or null
    let locId = null;
    if (location_id !== undefined && location_id !== null && location_id !== '' && location_id !== 'other') {
      if (typeof location_id !== 'string' || location_id.length > 50) {
        return res.status(400).json({ error: 'Invalid location' });
      }
      // Verify location actually exists
      const { data: locRow } = await supabase
        .from('locations')
        .select('id')
        .eq('id', location_id)
        .single();
      if (!locRow) {
        return res.status(400).json({ error: 'Selected location does not exist' });
      }
      locId = location_id;
    }
    const isOther = location_id === 'other';

    // Custom facility fields: only used when location_id === 'other'
    let facName = null, facAddr = null;
    if (isOther) {
      facName = typeof custom_facility_name === 'string' ? custom_facility_name.trim() : '';
      facAddr = typeof custom_facility_address === 'string' ? custom_facility_address.trim() : '';
      if (!facName) {
        return res.status(400).json({ error: 'Facility name is required when using "Other" location' });
      }
      facName = facName.slice(0, LIMITS.custom_facility_name);
      facAddr = (facAddr || '').slice(0, LIMITS.custom_facility_address) || null;
    }

    // location_instructions: merge into existing JSONB
    // Frontend sends:
    //   location_instructions_key: which location to update (location_id OR 'custom')
    //   location_instructions_for_key: the instructions text for that key
    const existingInstructions = coach.location_instructions || {};
    let mergedInstructions = { ...existingInstructions };
    if (typeof location_instructions_key === 'string' && location_instructions_key) {
      // Validate the key matches a real location_id or is 'custom'
      const keyOk = location_instructions_key === 'custom' ||
                    location_instructions_key === locId;
      if (!keyOk) {
        return res.status(400).json({ error: 'Instructions key does not match location' });
      }
      const instrText = typeof location_instructions_for_key === 'string'
        ? location_instructions_for_key.trim()
        : '';
      if (instrText.length > LIMITS.instructions) {
        return res.status(400).json({ error: `Instructions are too long (max ${LIMITS.instructions} characters)` });
      }
      if (instrText) {
        mergedInstructions[location_instructions_key] = instrText;
      } else {
        delete mergedInstructions[location_instructions_key];
      }
    }

    // ─── 5. Build the update object — only allowed fields ───
    const updates = {
      first_name: first_name.trim(),
      last_name: last_name.trim(),
      phone: (phone || '').trim() || null,
      instagram: (instagram || '').trim() || null,
      website: (website || '').trim() || null,
      linkedin: (linkedin || '').trim() || null,
      certifications: (certifications || '').trim() || null,
      achievements: (achievements || '').trim() || null,
      price: priceNum,
      location_id: locId,
      custom_facility_name: isOther ? facName : null,
      custom_facility_address: isOther ? facAddr : null,
      location_instructions: mergedInstructions,
      short_bio: (short_bio || '').trim() || null,
      full_bio: (full_bio || '').trim() || null,
      pga_certified: pgaCert,
      years_experience: yearsNum,
      specialties: specs,
      updated_at: new Date().toISOString(),
    };

    // ─── 6. Write to DB ───
    const { error: updateErr } = await supabase
      .from('coaches')
      .update(updates)
      .eq('id', coach.id);

    if (updateErr) {
      console.error('Profile update error:', updateErr);
      return res.status(500).json({ error: 'Could not save profile' });
    }

    return res.status(200).json({ success: true, updates });

  } catch (err) {
    console.error('Save coach profile error:', err);
    return res.status(500).json({ error: 'Something went wrong saving your profile' });
  }
}

function prettyName(field) {
  const map = {
    first_name: 'First name',
    last_name: 'Last name',
    phone: 'Phone',
    instagram: 'Instagram',
    website: 'Website',
    linkedin: 'LinkedIn',
    certifications: 'Certifications',
    achievements: 'Achievements',
    custom_facility_name: 'Facility name',
    custom_facility_address: 'Facility address',
    short_bio: 'Short bio',
    full_bio: 'Full bio',
  };
  return map[field] || field;
}

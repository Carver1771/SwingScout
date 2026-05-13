// ═══════════════════════════════════════════════════════
// SEND REVIEW PROMPTS
// ═══════════════════════════════════════════════════════
// Cron-triggered. Runs every 30 min. Finds confirmed, paid
// lessons that ended 3+ hours ago and haven't yet had a review
// prompt email sent. Sends the email and marks the booking
// so we never re-send.
//
// Triggered by Vercel cron (see vercel.json). Also callable
// manually via GET for debugging — protected by the CRON_SECRET
// env var if you want to restrict it (optional, see below).
// ═══════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Lessons are stored as Dallas/TX local times. The system runs in
// Central Time. This offset converts a "YYYY-MM-DD" + "H:MM AM/PM"
// local-time string into a UTC Date.
const TX_TIMEZONE = 'America/Chicago';

// How long to wait after a lesson ends before sending the email.
const DELAY_HOURS = 3;

// Don't email if the lesson is more than this many hours in the past.
// Catches a startup window where we might have a backlog, but avoids
// emailing about ancient lessons if there's a deploy gap or bug.
const MAX_HOURS_OLD = 48;

export default async function handler(req, res) {
  // Vercel cron calls this with GET. Allow POST too for manual invocation.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Optional auth: if CRON_SECRET env var is set, require it as bearer token.
  // Vercel cron automatically sends this header. If not set, anyone can hit
  // the endpoint, but it's idempotent and won't double-send.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    // Fetch confirmed, paid bookings that haven't gotten a review prompt yet.
    // We pull from the last 7 days as a generous window (covers cron gaps),
    // then filter in JS by exact 3-hour-after-end logic.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().slice(0, 10);

    const { data: bookings, error: bookErr } = await supabase
      .from('bookings')
      .select('id, student_name, student_email, student_token, booking_date, booking_time, coach_id, coaches(first_name, last_name, photo_url)')
      .eq('status', 'confirmed')
      .eq('payment_status', 'paid')
      .is('review_email_sent_at', null)
      .gte('booking_date', sevenDaysAgoStr)
      .limit(100);

    if (bookErr) {
      console.error('Could not fetch bookings:', bookErr);
      return res.status(500).json({ error: 'DB error', detail: bookErr.message });
    }

    const now = Date.now();
    const eligible = [];

    for (const b of bookings || []) {
      // Skip if missing data
      if (!b.student_email || !b.coaches || !b.booking_date || !b.booking_time) continue;

      const lessonStartMs = parseLocalDateTime(b.booking_date, b.booking_time);
      if (!lessonStartMs) continue;

      // Assume a 1-hour lesson. "Ended" = lessonStart + 1h.
      const lessonEndMs = lessonStartMs + 60 * 60 * 1000;
      const hoursSinceEnd = (now - lessonEndMs) / (60 * 60 * 1000);

      if (hoursSinceEnd >= DELAY_HOURS && hoursSinceEnd <= MAX_HOURS_OLD) {
        eligible.push(b);
      }
    }

    if (!eligible.length) {
      return res.status(200).json({ checked: bookings?.length || 0, sent: 0 });
    }

    // Send all the emails sequentially so we can mark each as sent only
    // after success. (Parallel would risk inconsistencies if some fail.)
    let sent = 0;
    let failed = 0;
    const siteUrl = process.env.SITE_URL || 'https://swingablegolf.com';

    for (const b of eligible) {
      const coachName = `${b.coaches.first_name} ${b.coaches.last_name}`;
      const studentFirstName = (b.student_name || 'there').split(' ')[0];
      const reviewLink = `${siteUrl}/?review_for=${b.coach_id}&token=${b.student_token}&booking=${b.id}`;
      const lessonDateStr = formatDate(b.booking_date);

      try {
        const emailRes = await fetch(`${siteUrl}/api/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'review_prompt',
            data: {
              studentEmail: b.student_email,
              studentName: studentFirstName,
              coachName,
              coachFirstName: b.coaches.first_name,
              coachPhoto: b.coaches.photo_url || '',
              lessonDate: lessonDateStr,
              lessonTime: b.booking_time,
              reviewLink,
            },
          }),
        });

        if (!emailRes.ok) {
          const errTxt = await emailRes.text();
          throw new Error(`Email API returned ${emailRes.status}: ${errTxt}`);
        }

        // Mark sent — done after successful email send so failures retry next run
        const { error: markErr } = await supabase
          .from('bookings')
          .update({ review_email_sent_at: new Date().toISOString() })
          .eq('id', b.id);

        if (markErr) {
          // We sent the email but couldn't mark it. Log loudly — next run will resend.
          console.error(`Sent email for booking ${b.id} but couldn't mark as sent:`, markErr);
        }

        sent++;
      } catch (sendErr) {
        console.error(`Review prompt failed for booking ${b.id}:`, sendErr.message);
        failed++;
      }
    }

    return res.status(200).json({
      checked: bookings?.length || 0,
      eligible: eligible.length,
      sent,
      failed,
    });
  } catch (err) {
    console.error('Review prompt cron error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Helpers ───

// Parse "YYYY-MM-DD" + "H:MM AM/PM" as a wall-clock time in TX_TIMEZONE,
// return ms since epoch. Returns null on parse failure.
function parseLocalDateTime(dateStr, timeStr) {
  // dateStr: "2026-05-13"
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!dateMatch) return null;
  const [, yyyy, mm, dd] = dateMatch;

  // timeStr: "9:00 AM" or "12:30 PM"
  const timeMatch = /^([1-9]|1[0-2]):([0-5][0-9])\s?(AM|PM)$/i.exec((timeStr || '').trim());
  if (!timeMatch) return null;
  let hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);
  const period = timeMatch[3].toUpperCase();
  if (period === 'PM' && hour !== 12) hour += 12;
  if (period === 'AM' && hour === 12) hour = 0;

  // Treat the parsed datetime as local time in TX_TIMEZONE.
  // The trick: build a UTC date, then compute the offset for TX at that
  // moment, then subtract it. Handles DST correctly.
  const utcGuess = Date.UTC(+yyyy, +mm - 1, +dd, hour, minute);
  const offsetMin = getTzOffsetMinutes(utcGuess, TX_TIMEZONE);
  return utcGuess - offsetMin * 60 * 1000;
}

// Returns the timezone offset in minutes from UTC at a given instant.
// Positive means the local time is ahead of UTC; negative means behind.
// For Dallas in CDT this is -300 (UTC-5), in CST it's -360 (UTC-6).
function getTzOffsetMinutes(utcMs, tz) {
  // Use Intl.DateTimeFormat to extract the local time, then subtract.
  const date = new Date(utcMs);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  // Some locales return "24" for midnight — normalize.
  if (map.hour === '24') map.hour = '00';
  const asUtcOfLocalParts = Date.UTC(
    +map.year, +map.month - 1, +map.day,
    +map.hour, +map.minute, +map.second
  );
  return (asUtcOfLocalParts - utcMs) / 60000;
}

function formatDate(dateStr) {
  // "2026-05-13" → "Wednesday, May 13"
  try {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

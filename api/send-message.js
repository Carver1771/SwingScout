// ═══════════════════════════════════════════════════════
// SEND MESSAGE
// ═══════════════════════════════════════════════════════
// Routes a message from student → coach or coach → student
// as an email. The recipient can reply directly to the email
// since the from-email is set to the sender's address.
//
// Authentication:
//  - Student: must provide valid student_token
//  - Coach: must be authenticated via Supabase session (TODO)
// ═══════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { bookingId, studentToken, senderType, message } = req.body;

    if (!bookingId || !senderType || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (message.length > 2000) {
      return res.status(400).json({ error: 'Message too long (2000 char max)' });
    }

    // Fetch booking and verify auth
    const { data: booking, error: bookErr } = await supabase
      .from('bookings')
      .select('*, coaches(*)')
      .eq('id', bookingId)
      .single();

    if (bookErr || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Verify student authentication via token
    if (senderType === 'student') {
      if (!studentToken || booking.student_token !== studentToken) {
        return res.status(403).json({ error: 'Invalid token' });
      }
    }
    // Coach auth handled by frontend session for now

    const coachName = `${booking.coaches.first_name} ${booking.coaches.last_name}`;
    const coachEmail = booking.coaches.email;
    const studentName = booking.student_name;
    const studentEmail = booking.student_email;

    // Determine sender/recipient
    const fromName = senderType === 'student' ? studentName : coachName;
    const fromEmail = senderType === 'student' ? studentEmail : coachEmail;
    const toName = senderType === 'student' ? coachName : studentName;
    const toEmail = senderType === 'student' ? coachEmail : studentEmail;
    const counterpartLabel = senderType === 'student' ? 'student' : 'coach';

    const dateStr = new Date(booking.booking_date + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric'
    });

    const subject = `Message from ${fromName} (Swingable Golf lesson ${dateStr})`;
    const html = messageEmailTemplate({
      fromName, toName, message, dateStr, time: booking.booking_time,
      replyToEmail: fromEmail, counterpartLabel
    });

    // Send via send-email endpoint (using existing infrastructure)
    try {
      const sendRes = await fetch(`${process.env.SITE_URL || 'https://swingablegolf.com'}/api/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'message',
          data: {
            to: toEmail,
            subject,
            html,
            replyTo: fromEmail,
          },
        }),
      });

      if (!sendRes.ok) {
        const errText = await sendRes.text();
        throw new Error(`Email send returned ${sendRes.status}: ${errText}`);
      }
    } catch (sendErr) {
      console.error('Message send failed:', sendErr);
      return res.status(500).json({ error: 'Could not deliver message' });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Send message error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function messageEmailTemplate({ fromName, toName, message, dateStr, time, replyToEmail, counterpartLabel }) {
  const escapedMessage = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;line-height:1.6;max-width:560px;margin:0 auto;padding:24px">
    <p style="color:#9e9e9e;font-size:13px;margin-bottom:8px">New message from your ${counterpartLabel}</p>
    <h2 style="color:#14442b;font-family:Georgia,serif">Message from ${fromName}</h2>
    <p style="color:#6b6b6b;font-size:13px">Regarding lesson on ${dateStr} at ${time}</p>
    <div style="background:#f4f3f0;border-radius:10px;padding:18px 20px;margin:16px 0;font-size:15px;line-height:1.6">
      ${escapedMessage}
    </div>
    <p style="font-size:13px;color:#6b6b6b">Reply directly to this email to respond — your reply will go straight to ${fromName} (${replyToEmail}).</p>
    <p style="color:#9e9e9e;font-size:12px;margin-top:32px;border-top:1px solid #e8e6e1;padding-top:16px">Sent via Swingable Golf</p>
  </div>`;
}

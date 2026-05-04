// ═══════════════════════════════════════════════════════
// EMAIL NOTIFICATIONS (Resend)
// ═══════════════════════════════════════════════════════
// Sends transactional emails for booking events.
// Updated to support payment-related notifications.
// ═══════════════════════════════════════════════════════

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'Swingable Golf <team@swingablegolf.com>';
const ADMIN_EMAIL = 'team@swingablegolf.com';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not configured');
    return res.status(500).json({ error: 'Email service not configured' });
  }

  try {
    const { type, data } = req.body;

    let emails = [];

    switch (type) {

      // ─── NEW BOOKING REQUEST ───
      case 'booking': {
        // Email to coach
        emails.push({
          to: data.coachEmail,
          subject: `New lesson request from ${data.studentName}`,
          html: bookingRequestCoachEmail(data),
        });
        // Confirmation to student
        emails.push({
          to: data.studentEmail,
          subject: `Lesson request sent to ${data.coachName}`,
          html: bookingRequestStudentEmail(data),
        });
        break;
      }

      // ─── COACH APPROVED BOOKING (payment captured) ───
      case 'booking_confirmed': {
        emails.push({
          to: data.studentEmail,
          subject: `${data.coachName} confirmed your lesson — payment processed`,
          html: bookingConfirmedEmail(data),
        });
        break;
      }

      // ─── COACH DECLINED BOOKING (auth released) ───
      case 'booking_declined': {
        emails.push({
          to: data.studentEmail,
          subject: 'Your lesson request was not accepted',
          html: bookingDeclinedEmail(data),
        });
        break;
      }

      // ─── BOOKING REFUNDED ───
      case 'booking_refunded': {
        emails.push({
          to: data.studentEmail,
          subject: 'Your Swingable Golf lesson has been refunded',
          html: bookingRefundedEmail(data),
        });
        break;
      }

      // ─── COACH APPLICATION SUBMITTED ───
      case 'coach_application': {
        emails.push({
          to: ADMIN_EMAIL,
          subject: `New coach application: ${data.coachName}`,
          html: coachApplicationAdminEmail(data),
        });
        emails.push({
          to: data.coachEmail,
          subject: 'Your Swingable Golf application was received',
          html: coachApplicationCoachEmail(data),
        });
        break;
      }

      // ─── COACH APPROVED ───
      case 'coach_approved': {
        emails.push({
          to: data.coachEmail,
          subject: 'Welcome to Swingable Golf — set up your payouts',
          html: coachApprovedEmail(data),
        });
        break;
      }

      default:
        return res.status(400).json({ error: `Unknown email type: ${type}` });
    }

    // Send all emails in parallel
    const results = await Promise.allSettled(
      emails.map(email => sendEmail(email))
    );

    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) {
      console.error('Some emails failed:', failed);
    }

    return res.status(200).json({
      success: true,
      sent: results.length - failed.length,
      failed: failed.length,
    });

  } catch (err) {
    console.error('Email handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════
// RESEND API CALL
// ═══════════════════════════════════════════════════════
async function sendEmail({ to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error: ${err}`);
  }
  return res.json();
}

// ═══════════════════════════════════════════════════════
// EMAIL TEMPLATES — kept compact
// ═══════════════════════════════════════════════════════
const baseStyle = `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;line-height:1.6;max-width:560px;margin:0 auto;padding:24px`;
const buttonStyle = `display:inline-block;background:#1b5e3b;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0`;

function bookingRequestCoachEmail(d) {
  return `<div style="${baseStyle}">
    <h2 style="color:#14442b">New Lesson Request</h2>
    <p>${d.studentName} has requested a lesson with you.</p>
    <p style="background:#f4f3f0;padding:16px;border-radius:8px">
      <strong>Date:</strong> ${d.date}<br>
      <strong>Time:</strong> ${d.time}<br>
      <strong>Location:</strong> ${d.location}<br>
      <strong>Skill level:</strong> ${d.skillLevel}<br>
      <strong>Rate:</strong> ${d.price}
    </p>
    <p><strong>Student contact:</strong><br>
      Email: ${d.studentEmail}<br>
      Phone: ${d.studentPhone || 'Not provided'}
    </p>
    <p>The student's payment is authorized but not yet charged. Approve or decline within 24 hours from your dashboard.</p>
    <a href="https://swingablegolf.com/coach.html" style="${buttonStyle}">View in dashboard</a>
    <p style="color:#9e9e9e;font-size:12px;margin-top:32px">Swingable Golf · Dallas, TX</p>
  </div>`;
}

function bookingRequestStudentEmail(d) {
  return `<div style="${baseStyle}">
    <h2 style="color:#14442b">Request Sent to ${d.coachName}</h2>
    <p>Hi ${d.studentName.split(' ')[0]},</p>
    <p>Your lesson request has been sent. Your card has been authorized — but you won't be charged until ${d.coachName.split(' ')[0]} confirms.</p>
    <p style="background:#f4f3f0;padding:16px;border-radius:8px">
      <strong>Coach:</strong> ${d.coachName}<br>
      <strong>Date:</strong> ${d.date}<br>
      <strong>Time:</strong> ${d.time}<br>
      <strong>Location:</strong> ${d.location}
    </p>
    <p>You'll get a confirmation email once your coach accepts (usually within 24 hours).</p>
    <p style="color:#9e9e9e;font-size:12px;margin-top:32px">Swingable Golf · Questions? Reply to this email.</p>
  </div>`;
}

function bookingConfirmedEmail(d) {
  return `<div style="${baseStyle}">
    <h2 style="color:#14442b">You're Confirmed!</h2>
    <p>Hi ${d.studentName.split(' ')[0]},</p>
    <p><strong>${d.coachName}</strong> has confirmed your lesson. Your card has been charged.</p>
    <p style="background:#e8f5ec;padding:16px;border-radius:8px">
      <strong>Date:</strong> ${d.date}<br>
      <strong>Time:</strong> ${d.time}<br>
      <strong>Location:</strong> ${d.location}
    </p>
    <p>${d.coachName.split(' ')[0]} will reach out shortly with logistics. Don't forget your clubs (or ask if loaners are available).</p>
    <p style="color:#9e9e9e;font-size:12px;margin-top:32px">Swingable Golf · Need to cancel? Reply to this email.</p>
  </div>`;
}

function bookingDeclinedEmail(d) {
  return `<div style="${baseStyle}">
    <h2 style="color:#14442b">Lesson Update</h2>
    <p>Hi ${d.studentName.split(' ')[0]},</p>
    <p>Unfortunately, ${d.coachName} wasn't able to accept your request for ${d.date} at ${d.time}.</p>
    <p><strong>Good news:</strong> your card was only authorized, not charged. You'll see the hold drop off within 5-7 business days.</p>
    <a href="https://swingablegolf.com" style="${buttonStyle}">Find another coach</a>
    <p style="color:#9e9e9e;font-size:12px;margin-top:32px">Swingable Golf</p>
  </div>`;
}

function bookingRefundedEmail(d) {
  return `<div style="${baseStyle}">
    <h2 style="color:#14442b">Refund Processed</h2>
    <p>Hi ${d.studentName.split(' ')[0]},</p>
    <p>Your lesson with ${d.coachName} on ${d.date} at ${d.time} has been cancelled and refunded.</p>
    ${d.amount ? `<p style="background:#f4f3f0;padding:16px;border-radius:8px"><strong>Refund amount:</strong> ${d.amount}</p>` : ''}
    <p>Refunds typically appear in your account within 5-10 business days.</p>
    <a href="https://swingablegolf.com" style="${buttonStyle}">Book another lesson</a>
    <p style="color:#9e9e9e;font-size:12px;margin-top:32px">Swingable Golf</p>
  </div>`;
}

function coachApplicationAdminEmail(d) {
  return `<div style="${baseStyle}">
    <h2>New Coach Application</h2>
    <p style="background:#f4f3f0;padding:16px;border-radius:8px">
      <strong>Name:</strong> ${d.coachName}<br>
      <strong>Email:</strong> ${d.coachEmail}<br>
      <strong>Location:</strong> ${d.location}<br>
      <strong>Rate:</strong> $${d.price}/hr<br>
      <strong>Specialties:</strong> ${d.specialties}
    </p>
    <a href="https://swingablegolf.com/admin.html" style="${buttonStyle}">Review in admin</a>
  </div>`;
}

function coachApplicationCoachEmail(d) {
  return `<div style="${baseStyle}">
    <h2 style="color:#14442b">Application Received</h2>
    <p>Hi ${d.coachName.split(' ')[0]},</p>
    <p>Thanks for applying to teach on Swingable Golf. We typically review applications within 24-48 hours and will email you once your profile is approved.</p>
    <p>While you wait, you can finish setting up your profile, photo, and availability from your dashboard.</p>
    <a href="https://swingablegolf.com/coach.html" style="${buttonStyle}">Go to dashboard</a>
    <p style="color:#9e9e9e;font-size:12px;margin-top:32px">Swingable Golf · Dallas, TX</p>
  </div>`;
}

function coachApprovedEmail(d) {
  return `<div style="${baseStyle}">
    <h2 style="color:#14442b">You're Approved!</h2>
    <p>Hi ${d.coachName.split(' ')[0]},</p>
    <p>Welcome to Swingable Golf. Your profile is now live on the platform and students can book lessons with you.</p>
    <p><strong>One last step:</strong> connect your bank account so you can receive payouts. This takes about 2 minutes.</p>
    <a href="https://swingablegolf.com/coach.html" style="${buttonStyle}">Set up payouts</a>
    <p>Until you complete payout setup, students won't be able to book paid lessons with you.</p>
    <p style="color:#9e9e9e;font-size:12px;margin-top:32px">Swingable Golf · Questions? Reply to this email.</p>
  </div>`;
}

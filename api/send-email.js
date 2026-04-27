export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    return res.status(500).json({ error: 'Email service not configured' });
  }

  const { type, data } = req.body;

  try {
    const emails = [];

    if (type === 'booking') {
      const { studentName, studentEmail, studentPhone, skillLevel, coachName, coachEmail, location, date, time, price } = data;

      // 1. Email to student (confirmation)
      emails.push({
        from: 'Swingable Golf <hello@swingablegolf.com>',
        to: studentEmail,
        subject: `Lesson Confirmed — ${date} at ${time}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
            <div style="text-align:center;margin-bottom:24px">
              <h1 style="color:#14442b;font-size:22px;margin:0">Swingable Golf</h1>
            </div>
            <h2 style="color:#14442b;font-size:18px">Your lesson is confirmed!</h2>
            <p style="color:#333;line-height:1.6">Hi ${studentName},</p>
            <p style="color:#333;line-height:1.6">Your golf lesson has been booked. Here are the details:</p>
            <div style="background:#f5f5f0;border-radius:10px;padding:20px;margin:20px 0">
              <table style="width:100%;font-size:14px;color:#333">
                <tr><td style="padding:6px 0;font-weight:bold;width:100px">Coach</td><td>${coachName}</td></tr>
                <tr><td style="padding:6px 0;font-weight:bold">Date</td><td>${date}</td></tr>
                <tr><td style="padding:6px 0;font-weight:bold">Time</td><td>${time}</td></tr>
                <tr><td style="padding:6px 0;font-weight:bold">Location</td><td>${location}</td></tr>
                <tr><td style="padding:6px 0;font-weight:bold">Rate</td><td>${price}</td></tr>
              </table>
            </div>
            <p style="color:#333;line-height:1.6">Your coach may reach out to confirm or share additional details. If you need to reschedule or cancel, please reply to this email.</p>
            <p style="color:#333;line-height:1.6">See you on the course!</p>
            <hr style="border:none;border-top:1px solid #e8e6e1;margin:24px 0">
            <p style="color:#999;font-size:12px;text-align:center">Swingable Golf — Find golf coaches in Dallas–Fort Worth<br><a href="https://swingablegolf.com" style="color:#1b5e3b">swingablegolf.com</a></p>
          </div>`
      });

      // 2. Email to coach (new booking notification)
      if (coachEmail) {
        emails.push({
          from: 'Swingable Golf <hello@swingablegolf.com>',
          to: coachEmail,
          subject: `New Lesson Booking — ${studentName} on ${date}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
              <div style="text-align:center;margin-bottom:24px">
                <h1 style="color:#14442b;font-size:22px;margin:0">Swingable Golf</h1>
              </div>
              <h2 style="color:#14442b;font-size:18px">You have a new booking!</h2>
              <p style="color:#333;line-height:1.6">Hi ${coachName.split(' ')[0]},</p>
              <p style="color:#333;line-height:1.6">A student just booked a lesson with you:</p>
              <div style="background:#f5f5f0;border-radius:10px;padding:20px;margin:20px 0">
                <table style="width:100%;font-size:14px;color:#333">
                  <tr><td style="padding:6px 0;font-weight:bold;width:100px">Student</td><td>${studentName}</td></tr>
                  <tr><td style="padding:6px 0;font-weight:bold">Email</td><td><a href="mailto:${studentEmail}" style="color:#1b5e3b">${studentEmail}</a></td></tr>
                  <tr><td style="padding:6px 0;font-weight:bold">Phone</td><td>${studentPhone || '—'}</td></tr>
                  <tr><td style="padding:6px 0;font-weight:bold">Skill Level</td><td>${skillLevel || '—'}</td></tr>
                  <tr><td style="padding:6px 0;font-weight:bold">Date</td><td>${date}</td></tr>
                  <tr><td style="padding:6px 0;font-weight:bold">Time</td><td>${time}</td></tr>
                  <tr><td style="padding:6px 0;font-weight:bold">Location</td><td>${location}</td></tr>
                </table>
              </div>
              <p style="color:#333;line-height:1.6">Please reach out to ${studentName} to confirm the lesson. You can reply directly to their email above or call them.</p>
              <p style="color:#333;line-height:1.6">You can also view your bookings in your <a href="https://swingablegolf.com/coach.html" style="color:#1b5e3b">Coach Dashboard</a>.</p>
              <hr style="border:none;border-top:1px solid #e8e6e1;margin:24px 0">
              <p style="color:#999;font-size:12px;text-align:center">Swingable Golf — Find golf coaches in Dallas–Fort Worth<br><a href="https://swingablegolf.com" style="color:#1b5e3b">swingablegolf.com</a></p>
            </div>`
        });
      }

      // 3. Email to admin
      emails.push({
        from: 'Swingable Golf <hello@swingablegolf.com>',
        to: 'team@swingablegolf.com',
        subject: `[Admin] New Booking — ${studentName} → ${coachName}`,
        html: `
          <div style="font-family:Arial,sans-serif;padding:20px">
            <h2 style="color:#14442b">New Booking</h2>
            <p><strong>Student:</strong> ${studentName} (${studentEmail}, ${studentPhone || 'no phone'})</p>
            <p><strong>Coach:</strong> ${coachName} (${coachEmail || 'no email'})</p>
            <p><strong>When:</strong> ${date} at ${time}</p>
            <p><strong>Where:</strong> ${location}</p>
            <p><strong>Skill Level:</strong> ${skillLevel || '—'}</p>
            <p><strong>Rate:</strong> ${price}</p>
          </div>`
      });

    } else if (type === 'coach_application') {
      const { coachName, coachEmail, location, price, specialties } = data;

      // Email to admin about new application
      emails.push({
        from: 'Swingable Golf <hello@swingablegolf.com>',
        to: 'team@swingablegolf.com',
        subject: `[Admin] New Coach Application — ${coachName}`,
        html: `
          <div style="font-family:Arial,sans-serif;padding:20px">
            <h2 style="color:#14442b">New Coach Application</h2>
            <p><strong>Name:</strong> ${coachName}</p>
            <p><strong>Email:</strong> ${coachEmail}</p>
            <p><strong>Location:</strong> ${location || 'Not set'}</p>
            <p><strong>Rate:</strong> $${price}/hr</p>
            <p><strong>Specialties:</strong> ${specialties || '—'}</p>
            <p style="margin-top:16px"><a href="https://swingablegolf.com/admin.html" style="color:#1b5e3b;font-weight:bold">Review in Admin Panel →</a></p>
          </div>`
      });

      // Confirmation to coach
      emails.push({
        from: 'Swingable Golf <hello@swingablegolf.com>',
        to: coachEmail,
        subject: 'Application Received — Swingable Golf',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
            <div style="text-align:center;margin-bottom:24px">
              <h1 style="color:#14442b;font-size:22px;margin:0">Swingable Golf</h1>
            </div>
            <h2 style="color:#14442b;font-size:18px">We received your application!</h2>
            <p style="color:#333;line-height:1.6">Hi ${coachName.split(' ')[0]},</p>
            <p style="color:#333;line-height:1.6">Thanks for applying to teach on Swingable Golf. We're reviewing your profile and will get back to you shortly.</p>
            <p style="color:#333;line-height:1.6">In the meantime, you can log into your <a href="https://swingablegolf.com/coach.html" style="color:#1b5e3b">Coach Dashboard</a> to complete your profile, upload a photo, and set your availability.</p>
            <p style="color:#333;line-height:1.6">The more complete your profile, the faster we can approve you.</p>
            <hr style="border:none;border-top:1px solid #e8e6e1;margin:24px 0">
            <p style="color:#999;font-size:12px;text-align:center">Swingable Golf — Find golf coaches in Dallas–Fort Worth<br><a href="https://swingablegolf.com" style="color:#1b5e3b">swingablegolf.com</a></p>
          </div>`
      });

    } else if (type === 'coach_approved') {
      const { coachName, coachEmail } = data;

      emails.push({
        from: 'Swingable Golf <hello@swingablegolf.com>',
        to: coachEmail,
        subject: 'You\'re Approved! Your profile is live — Swingable Golf',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
            <div style="text-align:center;margin-bottom:24px">
              <h1 style="color:#14442b;font-size:22px;margin:0">Swingable Golf</h1>
            </div>
            <h2 style="color:#14442b;font-size:18px">You're approved! 🎉</h2>
            <p style="color:#333;line-height:1.6">Hi ${coachName.split(' ')[0]},</p>
            <p style="color:#333;line-height:1.6">Great news — your profile on Swingable Golf has been approved and is now live! Students in the DFW area can find you, see your availability, and book lessons directly.</p>
            <div style="text-align:center;margin:24px 0">
              <a href="https://swingablegolf.com" style="background:#1b5e3b;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">View Your Profile</a>
            </div>
            <p style="color:#333;line-height:1.6">To manage your availability and see bookings, visit your <a href="https://swingablegolf.com/coach.html" style="color:#1b5e3b">Coach Dashboard</a>.</p>
            <hr style="border:none;border-top:1px solid #e8e6e1;margin:24px 0">
            <p style="color:#999;font-size:12px;text-align:center">Swingable Golf — Find golf coaches in Dallas–Fort Worth<br><a href="https://swingablegolf.com" style="color:#1b5e3b">swingablegolf.com</a></p>
          </div>`
      });
    }

    // Send all emails
    const results = await Promise.all(emails.map(email =>
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(email)
      }).then(r => r.json())
    ));

    return res.status(200).json({ success: true, sent: results.length });

  } catch (error) {
    console.error('Email error:', error);
    return res.status(500).json({ error: 'Failed to send emails' });
  }
}

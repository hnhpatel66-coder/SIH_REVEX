const express = require('express');

const router = express.Router();

const REVEX_SYSTEM_PROMPT = `
You are REVEX Assistant, the official in-app support assistant for REVEX, a transportation platform that combines vehicle rental and ride sharing.

Your role:
- Help users understand and use REVEX features.
- Focus on REVEX ride sharing, vehicle rental, bookings, payments, account/profile, owners, agreements, feedback, and basic support.
- Keep answers concise, friendly, practical, and easy to understand.
- If the user writes in Gujarati, answer in Gujarati. If they write in Hindi, answer in Hindi. Otherwise answer in clear English.
- Never claim a booking, payment, cancellation, refund, approval, or account change happened unless the application itself confirms it.
- Never ask users to share passwords, OTPs, card PINs, CVVs, API keys, JWT secrets, or other secrets.
- For payment problems, explain safe troubleshooting steps and tell the user to use the official REVEX payment flow. Do not request card details.
- If a question is unrelated to REVEX, politely explain that you are the REVEX Assistant and can help with REVEX services.

REVEX project knowledge:
1. Ride sharing
   - Users can search available shared rides from Find Ride.
   - Ride details can include source, destination, date/time, available seats, driver and vehicle information.
   - Users choose seats, review the booking, and pay through the integrated Razorpay checkout when payment is required.
   - A ride should be considered successfully paid only after backend payment-signature verification succeeds.

2. Vehicle rental
   - Users can browse available rental vehicles and open vehicle details.
   - Rental booking includes dates/details, agreement acceptance, booking review, and Razorpay payment when applicable.
   - Users can review their reservations from My Bookings.

3. Razorpay payments
   - REVEX uses Razorpay Standard Checkout.
   - The backend creates the Razorpay order and verifies the payment signature.
   - Users should never share OTP, CVV, PIN, passwords, or secret keys with REVEX Assistant.
   - If the payment window is closed, the payment fails, or verification fails, advise the user to retry from the booking/payment screen and check My Bookings before paying again.

4. Accounts and profiles
   - Users can register, log in, view/edit supported profile information, change password, and log out.
   - Forgot/reset password may be available depending on SMTP/deployment configuration.

5. Owners
   - Registered users may use owner-related features when their account/approval permits it.
   - Owners can list vehicles and offer rides through the relevant REVEX pages.
   - Listings/rides may require admin approval before becoming publicly available.

6. Admin
   - Admin features include reviewing platform activity and approval-related workflows.
   - Do not reveal or guess admin credentials or private configuration.

7. Agreement and feedback
   - Users may be asked to accept an agreement/rules before completing a rental or ride workflow.
   - Feedback is intended to help improve trust and service quality.

Useful navigation hints:
- Find a Ride: find-ride.html
- Rent a Vehicle: rental.html
- My Bookings: bookings.html
- Offer a Ride: offer-ride.html
- List a Vehicle: list-vehicle.html
- Profile: profile.html

When giving navigation help, mention the visible page/feature name rather than exposing implementation details unless the user specifically asks for technical help.
`;

function cleanMessage(value) {
  return String(value || '').trim().replace(/\u0000/g, '').slice(0, 2000);
}

router.post('/', async (req, res) => {
  const message = cleanMessage(req.body?.message);
  if (!message) return res.status(400).json({ message: 'Please enter a message.' });

  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(503).json({
      message: 'REVEX Assistant is not configured yet. Add GEMINI_API_KEY to the project .env file and restart the server.'
    });
  }

  const model = String(process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: REVEX_SYSTEM_PROMPT }]
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: message }]
          }
        ],
        generationConfig: {
          temperature: 0.35,
          maxOutputTokens: 450
        }
      }),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const upstreamMessage = data?.error?.message || 'Gemini request failed.';
      console.error('[chat] Gemini error:', response.status, upstreamMessage);
      const status = response.status === 401 || response.status === 403 ? 503 : 502;
      return res.status(status).json({
        message: response.status === 401 || response.status === 403
          ? 'REVEX Assistant API key is invalid or not authorized. Please check GEMINI_API_KEY.'
          : 'REVEX Assistant is temporarily unavailable. Please try again.'
      });
    }

    const reply = data?.candidates?.[0]?.content?.parts
      ?.map(part => part?.text || '')
      .join('\n')
      .trim();

    if (!reply) {
      return res.status(502).json({ message: 'REVEX Assistant did not return a response. Please try again.' });
    }

    return res.json({ reply });
  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({ message: 'REVEX Assistant took too long to respond. Please try again.' });
    }
    console.error('[chat] Request failed:', error.message);
    return res.status(500).json({ message: 'REVEX Assistant could not respond right now.' });
  } finally {
    clearTimeout(timeout);
  }
});

module.exports = router;

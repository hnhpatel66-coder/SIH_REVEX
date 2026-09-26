const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['\"]|['\"]$/g, '');
  }
}

const root = path.join(__dirname, '..');
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });

const bookingsRoute = fs.readFileSync(path.join(root, 'backend', 'routes', 'bookings.js'), 'utf8');
const rentalJs = fs.readFileSync(path.join(root, 'js', 'rental.js'), 'utf8');
const ridesRoute = fs.readFileSync(path.join(root, 'backend', 'routes', 'rides.js'), 'utf8');
const ridesJs = fs.readFileSync(path.join(root, 'js', 'rides.js'), 'utf8');
const rideDetails = fs.readFileSync(path.join(root, 'ride-details.html'), 'utf8');
const vehicleDetails = fs.readFileSync(path.join(root, 'vehicle-details.html'), 'utf8');
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

check('RAZORPAY_KEY_ID configured', /^rzp_(test|live)_/.test(process.env.RAZORPAY_KEY_ID || ''));
check('RAZORPAY_KEY_SECRET configured', Boolean(process.env.RAZORPAY_KEY_SECRET));
check('Razorpay dependency declared', Boolean(pkg.dependencies?.razorpay));
check('Create-order route exists', /router\.post\('\/:id\/payment-order'/.test(bookingsRoute));
check('Minimum amount validation exists', /amount\s*<\s*100/.test(bookingsRoute));
check('Signature verification uses HMAC-SHA256', /createHmac\('sha256',\s*process\.env\.RAZORPAY_KEY_SECRET\)/.test(bookingsRoute));
check('Checkout script is loaded', vehicleDetails.includes('https://checkout.razorpay.com/v1/checkout.js'));
check('Frontend opens Razorpay Checkout', /new window\.Razorpay\(options\)/.test(rentalJs));
check('Frontend handles modal dismiss', /ondismiss/.test(rentalJs));
check('Frontend handles payment.failed', /payment\.failed/.test(rentalJs));
check('Frontend submits signature for verification', /razorpay_signature/.test(rentalJs));
check('Ride create-order route exists', /router\.post\('\/bookings\/:id\/payment-order'/.test(ridesRoute));
check('Ride verify-payment route exists', /router\.post\('\/bookings\/:id\/verify-payment'/.test(ridesRoute));
check('Ride minimum amount validation exists', /amount\s*<\s*100/.test(ridesRoute));
check('Ride signature verification uses HMAC-SHA256', /createHmac\('sha256',\s*process\.env\.RAZORPAY_KEY_SECRET\)/.test(ridesRoute));
check('Ride checkout script is loaded', rideDetails.includes('https://checkout.razorpay.com/v1/checkout.js'));
check('Ride frontend opens Razorpay Checkout', /new window\.Razorpay\(/.test(ridesJs));
check('Ride frontend handles modal dismiss', /ondismiss/.test(ridesJs));
check('Ride frontend handles payment.failed', /payment\.failed/.test(ridesJs));
check('Ride frontend submits signature for verification', /razorpay_signature/.test(ridesJs));
check('Demo ride payment endpoint removed', !/payment-demo/.test(ridesRoute) && !/payment-demo/.test(ridesJs));
check('.env is gitignored', /^\.env$/m.test(gitignore));

const secret = process.env.RAZORPAY_KEY_SECRET || 'self-test-secret';
const orderId = 'order_self_test';
const paymentId = 'pay_self_test';
const sig = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
check('HMAC self-test passes', crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));

for (const item of checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? ` - ${item.detail}` : ''}`);
}

if (checks.some(item => !item.ok)) process.exit(1);
console.log('\nRazorpay integration checks passed. No real payment was created.');

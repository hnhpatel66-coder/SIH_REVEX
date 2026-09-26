const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const checks = [];
const add = (name, ok) => checks.push({ name, ok: Boolean(ok) });
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const server = read('backend/server.js');
const api = read('api/index.js');
const route = read('backend/routes/chat.js');
const client = read('js/chatbot.js');
const css = read('css/chatbot.css');
const envExample = read('.env.example');
const htmlFiles = fs.readdirSync(root).filter(name => name.endsWith('.html'));

add('Local backend mounts /api/chat', server.includes("app.use('/api/chat', chatRoutes)"));
add('Serverless backend mounts /api/chat', api.includes("app.use('/api/chat', chatRoutes)"));
add('Gemini API key stays server-side', route.includes('process.env.GEMINI_API_KEY') && !client.includes('GEMINI_API_KEY'));
add('REVEX project-specific system prompt exists', route.includes('REVEX Assistant') && route.includes('Razorpay') && route.includes('vehicle rental'));
add('Gemini model is configurable', route.includes('process.env.GEMINI_MODEL'));
add('Frontend calls /api/chat', client.includes('/chat'));
add('Right-bottom launcher exists', css.includes('right: 24px') && css.includes('bottom: 24px'));
add('Chatbot added to all top-level HTML pages', htmlFiles.every(name => read(name).includes('js/chatbot.js') && read(name).includes('css/chatbot.css')));
add('.env example documents Gemini key', envExample.includes('GEMINI_API_KEY='));

let failed = false;
for (const check of checks) {
  if (!check.ok) failed = true;
  console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}`);
}
if (failed) process.exit(1);
console.log('\nREVEX Assistant integration checks passed.');

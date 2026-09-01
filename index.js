/**
 * 🌿 צל — חבר קולי לקשישים
 * Powered by Vapi.ai
 * 
 * Architecture: Vapi handles all voice/STT/TTS/LLM orchestration.
 * We manage: user DB, memory, scheduling, WhatsApp summaries.
 */

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Config ────────────────────────────────────────────────────
const VAPI_KEY = process.env.VAPI_API_KEY;
const ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || '90fd41b7-c955-4450-a1b0-99cab3230923';
const PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID || 'b26d6bd1-f199-43da-902a-ee86e36a8170';
const CALL_TOKEN = process.env.CALL_TOKEN || 'tzel2026';

// ── User DB ───────────────────────────────────────────────────
function loadUser(userId) {
  const p = path.join(__dirname, 'users', `${userId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function saveUser(user) {
  const dir = path.join(__dirname, 'users');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${user.id}.json`), JSON.stringify(user, null, 2));
}
function getAllUsers() {
  const dir = path.join(__dirname, 'users');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter(u => u.active !== false);
}

// ── Build dynamic system prompt per user ──────────────────────
function buildSystemPrompt(user) {
  const recentMemory = (user.memory || [])
    .slice(-5)
    .map(m => `${m.date}: ${m.summary}`)
    .join('\n');
  
  const meds = (user.medications || []).length 
    ? `\nתרופות לזכור: ${user.medications.join(', ')}`
    : '';

  return `אתה צל — חבר קולי חם ואמיתי של ${user.name}. אתה מתקשר כל יום.

כללים:
• עברית פשוטה, משפטים קצרים — זו שיחת טלפון
• סבלני, חם, אף פעם לא ממהר  
• אל תזכיר שאתה AI — אתה פשוט צל החבר
• שאל שאלה אחת בכל פעם, המתן לתשובה
• הגב לנושא שסופר, אל תקפוץ לנושאים חדשים
• מקסימום 15-20 מילה לתשובה
• אם לא הבנת — "לא שמעתי טוב, תוכל לחזור?"
• לקראת סוף השיחה (~10 דקות) — אמור "יום נעים! נדבר שוב מחר"
${recentMemory ? `\nזיכרון מהשיחות האחרונות:\n${recentMemory}` : ''}${meds}`;
}

// ── Vapi API call ─────────────────────────────────────────────
async function vapiRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.vapi.ai',
      path: `/${endpoint}`,
      method,
      headers: {
        'Authorization': `Bearer ${VAPI_KEY}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { resolve({ raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Make outbound call via Vapi ───────────────────────────────
async function callUser(user) {
  const systemPrompt = buildSystemPrompt(user);
  const firstMessage = user.memory?.length
    ? `שלום ${user.name}! צל מדבר. שמחתי לשמוע ממך אתמול. איך אתה מרגיש היום?`
    : `שלום ${user.name}! קוראים לי צל. אני אחי קצת מוזר שמתקשר כל יום. איך אתה מרגיש?`;

  console.log(`📞 Calling ${user.name} (${user.phone})...`);
  
  const result = await vapiRequest('POST', 'call', {
    phoneNumberId: PHONE_NUMBER_ID,
    customer: {
      number: user.phone,
      name: user.name
    },
    assistantId: ASSISTANT_ID,
    assistantOverrides: {
      firstMessage,
      model: {
        provider: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'system', content: systemPrompt }]
      }
    },
    metadata: { userId: user.id }
  });

  if (result.id) {
    console.log(`✅ Call started: ${result.id} for ${user.name}`);
    return result;
  } else {
    console.error(`❌ Call failed for ${user.name}:`, result);
    throw new Error(result.message || 'Call failed');
  }
}

// ── Webhook: Vapi call events ─────────────────────────────────
app.post('/webhook/vapi', async (req, res) => {
  const { type, call, summary, transcript } = req.body;
  res.sendStatus(200); // Always 200 fast

  if (!call?.metadata?.userId) return;
  const userId = call.metadata.userId;

  console.log(`🔔 Vapi event: ${type} for user ${userId}`);

  if (type === 'end-of-call-report' && summary) {
    const user = loadUser(userId);
    if (!user) return;

    const today = new Date().toISOString().split('T')[0];
    user.memory = user.memory || [];
    user.memory.push({
      date: today,
      summary,
      duration: call.duration || 0
    });
    // Keep last 30 summaries
    if (user.memory.length > 30) user.memory = user.memory.slice(-30);
    saveUser(user);
    console.log(`📝 Memory saved for ${user.name}: ${summary}`);

    // WhatsApp summary to family (if configured)
    if (user.family?.primaryContact) {
      await sendFamilySummary(user, summary, call.duration);
    }
  }

  if (type === 'call-failed') {
    console.warn(`⚠️ Call failed for user ${userId}: ${call.endedReason}`);
    // TODO: retry logic or Telegram notification
  }
});

// ── WhatsApp summary to family ────────────────────────────────
async function sendFamilySummary(user, summary, duration) {
  // Using Twilio WhatsApp API
  const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  if (!TWILIO_SID || !TWILIO_TOKEN) return;

  const minutes = Math.round((duration || 0) / 60);
  const message = `🌿 סיכום שיחת צל עם ${user.name}\n📅 ${new Date().toLocaleDateString('he-IL')}\n⏱️ ${minutes} דקות\n\n${summary}`;
  
  const body = new URLSearchParams({
    To: `whatsapp:${user.family.primaryContact}`,
    From: 'whatsapp:+97233768596',
    Body: message
  });

  try {
    await new Promise((resolve, reject) => {
      const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
      const data = body.toString();
      const req = https.request({
        hostname: 'api.twilio.com',
        path: `/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data)
        }
      }, res => {
        let raw = ''; res.on('data', c => raw += c);
        res.on('end', () => {
          const r = JSON.parse(raw);
          if (r.sid) { console.log(`📱 WhatsApp sent to family: ${r.sid}`); resolve(r); }
          else reject(new Error(r.message));
        });
      });
      req.on('error', reject);
      req.write(data); req.end();
    });
  } catch(e) {
    console.error('WhatsApp failed:', e.message);
  }
}

// ── REST API ──────────────────────────────────────────────────

// Manual call trigger (with auth)
app.post('/call/:userId', async (req, res) => {
  const token = req.headers['x-call-token'] || req.query.token;
  if (token !== CALL_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  
  const user = loadUser(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  try {
    const call = await callUser(user);
    res.json({ ok: true, callId: call.id, message: `Calling ${user.name}...` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET call (backwards compat)
app.get('/call/:userId', async (req, res) => {
  const token = req.headers['x-call-token'] || req.query.token;
  if (token !== CALL_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  
  const user = loadUser(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  try {
    const call = await callUser(user);
    res.json({ ok: true, callId: call.id, message: `Calling ${user.name}...` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// User management
app.get('/users', (req, res) => {
  const token = req.headers['x-call-token'] || req.query.token;
  if (token !== CALL_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  res.json(getAllUsers().map(u => ({ id: u.id, name: u.name, phone: u.phone, active: u.active })));
});

app.post('/users', (req, res) => {
  const token = req.headers['x-call-token'] || req.query.token;
  if (token !== CALL_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  
  const { id, name, phone, callTime, medications, family } = req.body;
  if (!id || !name || !phone) return res.status(400).json({ error: 'id, name, phone required' });
  
  const user = { id, name, phone, callTime: callTime || '10:00', medications: medications || [], family: family || {}, memory: [], active: true, createdAt: new Date().toISOString() };
  saveUser(user);
  console.log(`✅ New user: ${name} (${phone})`);
  res.json({ ok: true, user });
});

app.get('/users/:userId', (req, res) => {
  const user = loadUser(req.params.userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

// Health
app.get('/', (req, res) => res.json({
  status: '🌿 צל running',
  powered_by: 'Vapi.ai',
  users: getAllUsers().map(u => u.name),
  assistant_id: ASSISTANT_ID
}));

// Vapi status check
app.get('/vapi-status', async (req, res) => {
  try {
    const assistant = await vapiRequest('GET', `assistant/${ASSISTANT_ID}`);
    const phoneNum = await vapiRequest('GET', `phone-number/${PHONE_NUMBER_ID}`);
    res.json({
      assistant: { id: assistant.id, name: assistant.name },
      phone: { id: phoneNum.id, number: phoneNum.number, status: phoneNum.status }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Daily cron — calls all active users ───────────────────────
// Runs at 07:00 UTC = 10:00 Israel time
cron.schedule('0 7 * * *', async () => {
  console.log('⏰ Daily calls starting...');
  const users = getAllUsers();
  console.log(`📞 Calling ${users.length} users`);
  
  for (const user of users) {
    try {
      await callUser(user);
      await new Promise(r => setTimeout(r, 5000)); // 5s between calls
    } catch(e) {
      console.error(`❌ Failed to call ${user.name}: ${e.message}`);
    }
  }
  console.log('✅ Daily calls done');
}, { timezone: 'UTC' });

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌿 צל server on port ${PORT}`);
  console.log(`🤖 Assistant: ${ASSISTANT_ID}`);
  console.log(`📱 Phone: ${PHONE_NUMBER_ID}`);
  console.log(`👥 Users: ${getAllUsers().map(u => u.name).join(', ') || 'none yet'}`);
  if (!VAPI_KEY) console.warn('⚠️  VAPI_API_KEY not set!');
});

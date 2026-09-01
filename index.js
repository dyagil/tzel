/**
 * 🌿 צל — חבר קולי לקשישים
 * Powered by Vapi.ai + Supabase
 */

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const https = require('https');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Config ────────────────────────────────────────────────────
const VAPI_KEY        = process.env.VAPI_API_KEY;
const ASSISTANT_ID    = process.env.VAPI_ASSISTANT_ID    || '90fd41b7-c955-4450-a1b0-99cab3230923';
const PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID || 'b26d6bd1-f199-43da-902a-ee86e36a8170';
const CALL_TOKEN      = process.env.CALL_TOKEN           || 'tzel2026';
const SUPABASE_URL    = process.env.SUPABASE_URL         || 'https://kothvoyqlmqtrlezgstj.supabase.co';
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY;

// ── Supabase REST helper ──────────────────────────────────────
async function sbFetch(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const url  = new URL(SUPABASE_URL + path);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=representation' : '',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── User DB (Supabase) ────────────────────────────────────────
async function loadUser(userId) {
  const rows = await sbFetch('GET', `/rest/v1/users?id=eq.${userId}&limit=1`);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function saveUser(user) {
  user.updated_at = new Date().toISOString();
  const existing = await loadUser(user.id);
  if (existing) {
    await sbFetch('PATCH', `/rest/v1/users?id=eq.${user.id}`, user);
  } else {
    await sbFetch('POST', '/rest/v1/users', user);
  }
}

async function getAllUsers() {
  const rows = await sbFetch('GET', '/rest/v1/users?active=eq.true&order=created_at');
  return Array.isArray(rows) ? rows : [];
}

// ── Call log (Supabase) ───────────────────────────────────────
async function saveCall(callData) {
  await sbFetch('POST', '/rest/v1/calls', callData).catch(e => console.error('saveCall error:', e.message));
}

// ── Build system prompt per user ──────────────────────────────
function buildSystemPrompt(user) {
  const recentMemory = (user.memory || [])
    .slice(-5)
    .map(m => `${m.date}: ${m.summary}`)
    .join('\n');

  const meds = (user.medications || []).length
    ? `\nתרופות לזכור: ${user.medications.join(', ')}`
    : '';

  return `אתה צל — חבר קולי חמה ואמיתית של ${user.name}. אתה מתקשרת כל יום.

כללים:
• תמיד בעברית — גם אם שומעת משהו מוזר, תמשיכי בעברית
• משפטים קצרים — מקסימום 15 מילה לתשובה
• שאלה אחת בכל פעם — לא יותר
• הגיבי למה שנאמר, אל תקפצי לנושאים אחרים
• אם לא הבנת — "לא שמעתי טוב, תוכל לחזור?"
• את חברה, לא מזכירה ולא AI — לעולם אל תגידי שאת בינה מלאכותית
• לקראת סוף השיחה (~10 דקות) — "יום נעים! אתקשר שוב מחר"
${recentMemory ? `\nזיכרון מהשיחות האחרונות:\n${recentMemory}` : ''}${meds}`;
}

// ── Vapi API helper ───────────────────────────────────────────
async function vapiRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.vapi.ai',
      path: `/${endpoint}`,
      method,
      headers: {
        'Authorization': `Bearer ${VAPI_KEY}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Make outbound call ────────────────────────────────────────
async function callUser(user) {
  const systemPrompt  = buildSystemPrompt(user);
  const hasMemory     = (user.memory || []).length > 0;
  const lastSummary   = hasMemory ? (user.memory[user.memory.length - 1].summary || '') : '';
  const firstMessage  = hasMemory
    ? `שלום ${user.name}! צל מדברת. ${lastSummary ? `בפעם הקודמת סיפרת לי — ${lastSummary.substring(0, 60)}. ` : ''}איך אתה מרגיש היום?`
    : `שלום ${user.name}! קוראים לי צל, אני אתקשר אליך כל יום. איך אתה מרגיש היום?`;

  console.log(`📞 Calling ${user.name} (${user.phone})...`);

  const result = await vapiRequest('POST', 'call', {
    phoneNumberId: PHONE_NUMBER_ID,
    customer: { number: user.phone, name: user.name },
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
    console.log(`✅ Call started: ${result.id}`);
    return result;
  } else {
    throw new Error(result.message || JSON.stringify(result));
  }
}

// ── Vapi Webhook ──────────────────────────────────────────────
app.post('/webhook/vapi', async (req, res) => {
  res.sendStatus(200); // respond fast always
  const { type, call, summary, transcript } = req.body;
  if (!call) return;

  const userId = call?.metadata?.userId;
  console.log(`🔔 ${type} | user:${userId} | reason:${call.endedReason || '-'}`);

  // Save call log
  await saveCall({
    id: call.id || `call-${Date.now()}`,
    user_id: userId || null,
    vapi_call_id: call.id,
    status: call.status || 'ended',
    duration: call.duration || null,
    ended_reason: call.endedReason || null,
    summary: summary || null,
    transcript: transcript || null,
  });

  if (type === 'end-of-call-report' && summary && userId) {
    const user = await loadUser(userId);
    if (!user) return;

    const today = new Date().toISOString().split('T')[0];
    const memory = user.memory || [];
    memory.push({ date: today, summary, duration: call.duration || 0 });
    if (memory.length > 30) memory.splice(0, memory.length - 30);

    await saveUser({ ...user, memory });
    console.log(`📝 Memory saved for ${user.name}`);

    // WhatsApp summary to family
    if (user.family?.primaryContact) {
      await sendFamilyWhatsApp(user, summary, call.duration);
    }
  }
});

// ── WhatsApp family summary ───────────────────────────────────
async function sendFamilyWhatsApp(user, summary, duration) {
  const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  if (!TWILIO_SID || !TWILIO_TOKEN) return;

  const minutes = Math.round((duration || 0) / 60);
  const today   = new Date().toLocaleDateString('he-IL');
  const msg     = `🌿 סיכום שיחת צל עם ${user.name}\n📅 ${today} | ⏱️ ${minutes} דקות\n\n${summary}`;

  const body = new URLSearchParams({ To: `whatsapp:${user.family.primaryContact}`, From: 'whatsapp:+97233768596', Body: msg });
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const data = body.toString();

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(raw);
          if (r.sid) console.log(`📱 WhatsApp sent: ${r.sid}`);
          else console.error('WhatsApp error:', r.message);
        } catch {}
        resolve();
      });
    });
    req.on('error', e => { console.error('WhatsApp request error:', e.message); resolve(); });
    req.write(data); req.end();
  });
}

// ── REST API ──────────────────────────────────────────────────
function authCheck(req, res) {
  const token = req.headers['x-call-token'] || req.query.token;
  if (token !== CALL_TOKEN) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

// Manual call
app.get('/call/:userId', async (req, res) => {
  if (!authCheck(req, res)) return;
  const user = await loadUser(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  try {
    const call = await callUser(user);
    res.json({ ok: true, callId: call.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/call/:userId', async (req, res) => {
  if (!authCheck(req, res)) return;
  const user = await loadUser(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  try {
    const call = await callUser(user);
    res.json({ ok: true, callId: call.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// User CRUD
app.get('/users', async (req, res) => {
  if (!authCheck(req, res)) return;
  const users = await getAllUsers();
  res.json(users.map(u => ({ id: u.id, name: u.name, phone: u.phone, active: u.active, memory_count: (u.memory||[]).length })));
});

app.post('/users', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id, name, phone, call_time, medications, family, note } = req.body;
  if (!id || !name || !phone) return res.status(400).json({ error: 'id, name, phone required' });
  const user = { id, name, phone, call_time: call_time || '10:00', medications: medications || [], family: family || {}, memory: [], active: true, note: note || null };
  await saveUser(user);
  console.log(`✅ New user: ${name} (${phone})`);
  res.json({ ok: true, user });
});

app.get('/users/:userId', async (req, res) => {
  const user = await loadUser(req.params.userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

app.delete('/users/:userId', async (req, res) => {
  if (!authCheck(req, res)) return;
  await sbFetch('PATCH', `/rest/v1/users?id=eq.${req.params.userId}`, { active: false });
  res.json({ ok: true });
});

// Call history
app.get('/calls/:userId', async (req, res) => {
  if (!authCheck(req, res)) return;
  const rows = await sbFetch('GET', `/rest/v1/calls?user_id=eq.${req.params.userId}&order=created_at.desc&limit=20`);
  res.json(rows);
});

// Health
app.get('/', async (req, res) => {
  const users = await getAllUsers();
  res.json({
    status: '🌿 צל running',
    powered_by: 'Vapi.ai + Supabase',
    users: users.map(u => u.name),
    assistant_id: ASSISTANT_ID
  });
});

// ── Daily cron — 10:00 Israel (07:00 UTC) ────────────────────
cron.schedule('0 7 * * *', async () => {
  console.log('⏰ Daily calls...');
  const users = await getAllUsers();
  console.log(`📞 Calling ${users.length} active users`);
  for (const user of users) {
    try {
      await callUser(user);
      await new Promise(r => setTimeout(r, 5000));
    } catch (e) {
      console.error(`❌ Failed ${user.name}: ${e.message}`);
    }
  }
}, { timezone: 'UTC' });

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌿 צל on port ${PORT}`);
  console.log(`🗄️  Supabase: ${SUPABASE_URL}`);
  console.log(`🤖 Assistant: ${ASSISTANT_ID}`);
  if (!VAPI_KEY)     console.warn('⚠️  VAPI_API_KEY missing');
  if (!SUPABASE_KEY) console.warn('⚠️  SUPABASE_SERVICE_KEY missing');
});

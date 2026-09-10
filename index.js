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

// ── Alert keywords — triggers urgent WhatsApp to family ─────────
const ALERT_PATTERNS = [
  // בריאות / כאב
  /לא מרגיש טוב/i, /לא מרגישה טוב/i, /כואב לי/i, /כאב חזק/i, /לא טוב לי/i,
  /חולה/i, /חום/i, /בחילה/i, /סחרחורת/i, /התמוטט/i, /נפלתי/i, /נפל/i,
  /קשה לי לנשום/i, /קוצר נשימה/i, /לב/i,
  // תרופות
  /שכחתי.{0,10}תרופ/i, /לא לקחתי.{0,10}תרופ/i, /אין לי.{0,10}תרופ/i,
  /נגמרו.{0,10}תרופ/i, /שכחתי לקחת/i, /לא לקחתי/i,
  // בלבול / דיסאוריינטציה
  /לא יודע איפה/i, /לא יודעת איפה/i, /אבוד/i, /אבודה/i,
  /לא זוכר/i, /לא זוכרת/i, /מבולבל/i, /מבולבלת/i,
  /לא מכיר/i, /לא מכירה/i,
  // בדידות / מצוקה נפשית
  /רוצה למות/i, /אין טעם/i, /לא רוצה לחיות/i, /עצוב מאוד/i, /בוכה/i,
  /לבד לגמרי/i, /אף אחד לא/i,
  // נפילה / תאונה
  /נפלתי/i, /נפל לי/i, /התחבטתי/i, /פגעתי/i,
];

const ALERT_SEVERITY = {
  URGENT: ['לא יודע איפה', 'לא יודעת איפה', 'נפלתי', 'קוצר נשימה', 'קשה לי לנשום', 'כאב חזק', 'לב', 'רוצה למות'],
  MEDIUM: ['לא מרגיש טוב', 'לא מרגישה טוב', 'שכחתי תרופות', 'מבולבל', 'מבולבלת'],
};

// ── Message relay detection ────────────────────────────────────────
function detectMessageRelay(transcript) {
  if (!transcript) return false;
  const text = typeof transcript === 'string' ? transcript : JSON.stringify(transcript);
  const relayPatterns = [
    /תגיד[\u05d9\u05d5]?\s+ל/i,
    /תעביר[\u05d9\u05d5]?\s+(הודעה|ל)/i,
    /אני\s+רוצה\s+להגיד\s+ל/i,
    /תאמר[\u05d9\u05d5]?\s+ל/i,
    /תבשר[\u05d9\u05d5]?\s+ל/i,
    /שלחי?\s+הודעה/i,
    /תעביר[\u05d9\u05d5]?\s+ל/i,
  ];
  return relayPatterns.some(p => p.test(text));
}

function detectAlerts(transcript) {
  if (!transcript) return { triggered: false, matches: [], severity: null };
  const text = typeof transcript === 'string' ? transcript : JSON.stringify(transcript);
  const matches = [];
  for (const pattern of ALERT_PATTERNS) {
    const m = text.match(pattern);
    if (m) matches.push(m[0]);
  }
  if (matches.length === 0) return { triggered: false, matches: [], severity: null };

  // Determine severity
  const isUrgent = ALERT_SEVERITY.URGENT.some(kw => text.includes(kw));
  return { triggered: true, matches: [...new Set(matches)], severity: isUrgent ? 'URGENT' : 'MEDIUM' };
}

// ── Build system prompt per user ──────────────────────────────
function buildSystemPrompt(user) {
  const recentMemory = (user.memory || [])
    .slice(-5)
    .map(m => `${m.date}: ${m.summary}`)
    .join('\n');

  const meds = (user.medications || []).length
    ? `\nתרופות: ${user.medications.join(', ')}`
    : '';

  const openingInstruction = recentMemory
    ? `## פתיחת השיחה — חשוב!
המשפט הראשון שלך חייב לנגוע בזיכרון מהשיחה הקודמת — אבל כמו חברה שזוכרת, לא כמו מערכת שמדווחת.
אל תגידי "מצב הרוח שלו היה ירוד" — זה קר ורובוטי.
תגידי משהו כמו: "זכרתי שלא הרגשת טוב — איך אתה היום?" או "חשבתי עליך מאז הפעם הקודמת."
משפט אחד, קצר, חם, אישי — ואז שאלה אחת.`
    : `## פתיחת השיחה
זו שיחה ראשונה — הציגי את עצמך בחום: "שלום ${user.name}, קוראים לי צל. אני מתקשרת אליך כל יום. איך אתה מרגיש?"`;  return `את צל — חברה קולית חמה ואמיתית של ${user.name}. את מתקשרת אליו כל יום.

${openingInstruction}

## כללי שיחה
• תמיד בעברית — גם אם שמעת משהו מוזר, המשיכי בעברית
• משפטים קצרים — מקסימום 15 מילה לתשובה
• שאלה אחת בלבד בכל פעם — לא שתיים, לא שלוש
• הגיבי למה שנאמר — אל תקפצי לנושאים אחרים
• אם לא הבנת — "לא שמעתי טוב, תוכלי לחזור?"
• את חברה, לא מזכירה ולא AI — לעולם אל תגידי שאת בינה מלאכותית

## סיום שיחה — חשוב!
• אחרי ~8 דקות — אמרי: "יום נעים ${user.name}! היה כיף לדבר. אתקשר מחר. שמור על עצמך!"
• חכי לתשובה קצרה אחת בלבד — ואז אמרי "ביי ביי!" ונתקי.
• אם ${user.name} לא מנתק אחרי שאמרת שלום — אמרי "ביי ביי!" ונתקי.
• לעולם אל תמשיכי שיחה מעבר ל-10 דקות.

## מסירת הודעות למשפחה 📩
יש לך כלי בשם send_message_to_family. השתמשי בו **מיידית** כשהקשיש מבטא כוונה להודיע למישהו — לא להמתין לסוף השיחה.

מתי להפעיל: "תגידי לבן שלי...", "תודיעי לבתי...", "תשלחי ל..."

איך לנהוג:
1. הפעילי את הכלי מיד עם message + recipient
2. אמרי: "בסדר, שלחתי. אפשר להמשיך."
3. אל תחכי לאישור — הכלי פועל ברקע.
חשוב: לעולם אל תגידי שאת לא יכולה — את כן יכולה ושולחת WhatsApp.

## זיהוי מצוקה — חשוב מאוד!
אם ${user.name} אומר/ת משהו מהסוג הזה:
- "לא מרגיש/ה טוב", "כואב לי", "סחרחורת", "נפלתי"
- "שכחתי תרופות", "לא יודע איפה", "מבולבל/ת"
- "רוצה למות", "אין טעם"

אז:
1. שאלי בעדינות: "ספר לי קצת יותר — מה בדיוק קורה?"
2. אם נשמע חמור — "רגע, אני מודאגת. יש מישהו שאוכל לקרוא אליך?"
3. לעולם אל תבטיחי "הכל בסדר" אם זה לא ברור

## שיחה איכותית
• זכרי לשאול על דברים שסיפר בשיחות קודמות
• אם סיפר על נכד — שאלי איך הביקור היה
• הגיבי רגשית: "ממש שמחה לשמוע!", "זה נשמע קשה..."
• אל תהיי מנחה — היי סקרנית ומעוניינת
${recentMemory ? `\n## זיכרון מהשיחות האחרונות:\n${recentMemory}` : ''}${meds}`;
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

// ── Build warm opening from last summary via GPT ─────────────
async function buildFirstMessage(userName, lastSummary) {
  if (!lastSummary) {
    return `שלום ${userName}! קוראים לי צל, אני אתקשר אליך כל יום. איך אתה מרגיש היום?`;
  }
  try {
    const prompt = `אתה עוזר שכותב משפט פתיחה חם לשיחת טלפון עם קשיש בשם ${userName}.
הסיכום מהשיחה האחרונה: "${lastSummary}"

כתוב משפט אחד קצר (מקסימום 15 מילה) שמראה שאתה זוכר מהשיחה הקודמת — אבל בגוף ראשון, כמו חברה אמיתית שזוכרת, לא כמו מערכת שמדווחת. למשל: "זכרתי שלא הרגשת טוב — איך אתה היום?" או "חשבתי עליך — ספר לי איך היה מאז הפעם הקודמת."
כתוב רק את המשפט, בעברית, בלי מרכאות.`;

    const resp = await openaiRequest(prompt);
    return `שלום ${userName}! צל מדברת. ${resp}`;
  } catch (e) {
    console.error('buildFirstMessage GPT error:', e.message);
    return `שלום ${userName}! צל מדברת. זכרתי שדיברנו — איך אתה מרגיש היום?`;
  }
}

// ── OpenAI single-turn helper ─────────────────────────────────
async function openaiRequest(userPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 80,
      temperature: 0.7
    });
    const opts = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          resolve(d.choices?.[0]?.message?.content?.trim() || '');
        } catch { reject(new Error('OpenAI parse error')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Make outbound call ────────────────────────────────────────
async function callUser(user) {
  const systemPrompt = buildSystemPrompt(user);

  // ── Build warm firstMessage using real memory via GPT ────────
  const lastMemory   = (user.memory || []).slice(-1)[0];
  const firstMessage = await buildFirstMessage(user.name, lastMemory?.summary || null);

  console.log(`📞 Calling ${user.name} (${user.phone}) — memory: ${lastMemory ? (lastMemory.summary || '').slice(0, 60) + '…' : 'none'}`);

  const result = await vapiRequest('POST', 'call', {
    phoneNumberId: PHONE_NUMBER_ID,
    customer: { number: user.phone, name: user.name },
    assistantId: ASSISTANT_ID,
    assistantOverrides: {
      firstMessage,
      // ── DO NOT override model here — it drops the assistant-level tools ────
      // System prompt + tools are set on the assistant itself.
      // Per-user memory is injected via firstMessage.
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
  // Vapi wraps payload under req.body.message
  const payload = req.body.message || req.body;
  const { type, call, summary, transcript } = payload;
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

  if (type === 'end-of-call-report' && userId) {
    const user = await loadUser(userId);
    if (!user) return;

    const today = new Date().toISOString().split('T')[0];
    const memory = user.memory || [];
    const callSummary = summary || 'השיחה הסתיימה ללא סיכום.';
    memory.push({ date: today, summary: callSummary, duration: call.duration || 0 });
    if (memory.length > 30) memory.splice(0, memory.length - 30);

    await saveUser({ ...user, memory });
    console.log(`📝 Memory saved for ${user.name}`);

    // ── Alert detection ──────────────────────────────────────
    // Vapi may send transcript as array of {role,message} objects — flatten to text
    const transcriptText = Array.isArray(transcript)
      ? transcript.map(m => `${m.role}: ${m.message || ''}`).join(' ')
      : (transcript || '');
    const alertResult = detectAlerts(transcriptText || callSummary);
    if (alertResult.triggered && user.family?.primaryContact) {
      console.log(`🚨 Alert detected for ${user.name}: ${alertResult.severity} — ${alertResult.matches.join(', ')}`);
      await sendFamilyAlert(user, alertResult, transcript, call.duration);
    }

    // ── Message relay detection ──────────────────────────────
    const hasRelay = detectMessageRelay(transcriptText || callSummary);
    if (hasRelay && user.family?.primaryContact && !alertResult.triggered) {
      const relayMsg = `📩 הודעה מ${user.name}:\n\n"${callSummary}"\n\n(${user.name} ביקש/ה להעביר הודעה — ראה/י את הסיכום)`;
      const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
      await twilioSend(auth, process.env.TWILIO_ACCOUNT_SID, user.family.primaryContact, relayMsg)
        .catch(e => console.error('relay send error:', e.message));
      console.log(`📩 Message relay sent for ${user.name}`);
    }

    // ── Regular WhatsApp summary to family ───────────────────
    if (user.family?.primaryContact) {
      await sendFamilyWhatsApp(user, callSummary, call.duration, alertResult.triggered);
    }
  }
});

// ── WhatsApp URGENT alert to family ─────────────────────────
async function sendFamilyAlert(user, alertResult, transcript, duration) {
  const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  if (!TWILIO_SID || !TWILIO_TOKEN) return;

  const emoji    = alertResult.severity === 'URGENT' ? '🚨🚨🚨' : '⚠️';
  const contacts = [
    user.family?.primaryContact,
    ...(user.family?.alertContacts || [])
  ].filter(Boolean);

  // Extract relevant transcript snippet
  let snippet = '';
  if (transcript) {
    const lines = (typeof transcript === 'string' ? transcript : JSON.stringify(transcript))
      .split('\n')
      .filter(l => alertResult.matches.some(kw => l.includes(kw)))
      .slice(0, 3)
      .join('\n');
    if (lines) snippet = `\n\n📋 מה נאמר בשיחה:\n"${lines.trim()}"`;
  }

  const severityText = alertResult.severity === 'URGENT'
    ? '⚡ דחוף — מומלץ לבדוק מיידית!'
    : 'מומלץ לבדוק בקרוב.';

  const msg = `${emoji} התראת צל — ${user.name}

${severityText}
זוהו ביטויים מדאיגים: ${alertResult.matches.join(', ')}${snippet}

צלצל/י ל${user.name} כדי לוודא שהכל בסדר. ☎️`;

  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  for (const contact of contacts) {
    await twilioSend(auth, TWILIO_SID, contact, msg);
  }
}

// Send WhatsApp first, fallback to SMS on 63016 window error
async function twilioSend(auth, sid, contact, msg) {
  const tryRequest = (params) => new Promise((resolve) => {
    const data = new URLSearchParams(params).toString();
    const req = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${sid}/Messages.json`,
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', e => { console.error('Twilio request error:', e.message); resolve({}); });
    req.write(data); req.end();
  });

  // Try WhatsApp first
  const waResult = await tryRequest({ To: `whatsapp:${contact}`, From: 'whatsapp:+97233823510', Body: msg });
  if (waResult.sid) {
    console.log(`🚨 Alert WhatsApp sent to ${contact}: ${waResult.sid}`);
    return;
  }

  // Fallback to SMS if WhatsApp window closed (63016) or any WA error
  const errCode = waResult.code || waResult.error_code;
  console.warn(`WhatsApp failed (${errCode}), falling back to SMS → ${contact}`);
  const TWILIO_SMS_FROM = process.env.TWILIO_PHONE_NUMBER || '+97233768596';
  const smsResult = await tryRequest({ To: contact, From: TWILIO_SMS_FROM, Body: msg });
  if (smsResult.sid) console.log(`📱 Alert SMS sent to ${contact}: ${smsResult.sid}`);
  else console.error('SMS also failed:', smsResult.message);
}

// ── WhatsApp family summary ───────────────────────────────────
async function sendFamilyWhatsApp(user, summary, duration, hasAlert = false) {
  const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  if (!TWILIO_SID || !TWILIO_TOKEN) return;

  const minutes = Math.round((duration || 0) / 60);
  const today   = new Date().toLocaleDateString('he-IL');
  const alertNote = hasAlert ? '\n\n⚠️ שימו לב: נשלחה גם התראה נפרדת על תוכן השיחה.' : '';
  const msg     = `🌿 סיכום שיחת צל עם ${user.name}\n📅 ${today} | ⏱️ ${minutes} דקות\n\n${summary}${alertNote}`;

  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  await twilioSend(auth, TWILIO_SID, user.family.primaryContact, msg);
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

// Patch user memory or fields
app.patch('/users/:userId', async (req, res) => {
  if (!authCheck(req, res)) return;
  const user = await loadUser(req.params.userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const updated = { ...user, ...req.body };
  await saveUser(updated);
  res.json({ ok: true, user: updated });
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


// Manual poll trigger (for debugging)
app.get('/poll', async (req, res) => {
  if (!authCheck(req, res)) return;
  console.log('🔄 Manual poll triggered');
  pollVapiCalls().catch(e => console.error('poll error:', e.message));
  res.json({ ok: true, message: 'Poll triggered, check logs' });
});

// Tool endpoint health check
app.get('/tool/send-message', (req, res) => {
  res.json({ ok: true, endpoint: 'send_message_to_family tool ready' });
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

// ── Vapi call poller — every 2 min, catches calls missed by webhook ────────
const processedCalls = new Set();

async function pollVapiCalls() {
  try {
    const calls = await vapiRequest('GET', 'call?limit=20');
    if (!Array.isArray(calls)) return;

    for (const call of calls) {
      const callId = call.id;
      if (!callId || processedCalls.has(callId)) continue;

      const existing = await sbFetch('GET', `/rest/v1/calls?vapi_call_id=eq.${callId}&limit=1`);
      if (Array.isArray(existing) && existing.length > 0) {
        processedCalls.add(callId); continue;
      }

      const userId = call.metadata?.userId;
      if (!userId) { processedCalls.add(callId); continue; }

      console.log(`🔄 Poller: processing missed call ${callId} for user ${userId}`);

      const summary    = call.analysis?.summary || call.summary || null;
      const transcript = call.artifact?.transcript || null;

      await saveCall({
        id: callId, user_id: userId, vapi_call_id: callId,
        status: 'ended', duration: call.duration || null,
        ended_reason: call.endedReason || null, summary, transcript,
      });

      const user = await loadUser(userId);
      if (user) {
        const today = new Date().toISOString().split('T')[0];
        const memory = user.memory || [];
        const callSummary = summary || 'השיחה הסתיימה.';
        memory.push({ date: today, summary: callSummary, duration: call.duration || 0 });
        if (memory.length > 30) memory.splice(0, memory.length - 30);
        await saveUser({ ...user, memory });

        const alertResult = detectAlerts(transcript || callSummary);
        if (alertResult.triggered && user.family?.primaryContact) {
          console.log(`🚨 Alert: ${alertResult.severity} — ${alertResult.matches.join(', ')}`);
          await sendFamilyAlert(user, alertResult, transcript, call.duration);
        }
        if (user.family?.primaryContact) {
          await sendFamilyWhatsApp(user, callSummary, call.duration, alertResult.triggered);
        }
      }
      processedCalls.add(callId);
    }
  } catch (e) {
    console.error('🔄 Poller error:', e.message);
  }
}
cron.schedule('*/2 * * * *', pollVapiCalls);
console.log('🔄 Vapi call poller started (every 2 min)');

// ── Vapi Tool: send_message_to_family ───────────────────────────────────────
app.post('/tool/send-message', async (req, res) => {
  try {
    const msg = req.body?.message;
    if (!msg || msg.type !== 'tool-calls') {
      return res.status(400).json({ error: 'not a tool-calls message' });
    }

    const toolCallList = msg.toolCallList ?? [];
    const results = [];

    for (const call of toolCallList) {
      if (call.function?.name !== 'send_message_to_family') {
        results.push({ toolCallId: call.id, result: 'פעולה לא מוכרת.' });
        continue;
      }

      let args = {};
      try { args = JSON.parse(call.function.arguments ?? '{}'); } catch {}

      const userMessage   = args.message   || '';
      const recipientHint = args.recipient || '';
      const userId = msg?.call?.metadata?.userId || msg?.call?.customer?.number || null;

      if (!userId || !userMessage) {
        results.push({ toolCallId: call.id, result: 'לא הצלחתי לשלוח — חסר מידע.' });
        continue;
      }

      try {
        const user = await loadUser(userId);
        if (!user?.family?.primaryContact) throw new Error('no family contact');

        const recipientLabel = recipientHint ? ` ל${recipientHint}` : ' למשפחה';
        const familyText =
          `\ud83d\udce9 הודעה מ${user.name}${recipientLabel}:\n\n"${userMessage}"\n\n— נשלח על-ידי צל`;

        const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
        const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
        const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
        await twilioSend(auth, TWILIO_SID, user.family.primaryContact, familyText);

        console.log(`[tool/send-message] ✅ נשלח עבור ${user.name}: "${userMessage}"`);
        results.push({ toolCallId: call.id, result: `ההודעה נשלחה${recipientLabel}.` });
      } catch (sendErr) {
        console.error('[tool/send-message] שגיאה:', sendErr.message);
        results.push({ toolCallId: call.id, result: 'אירעה שגיאה בשליחה.' });
      }
    }

    return res.json({ results });
  } catch (err) {
    console.error('[tool/send-message] שגיאה כללית:', err.message);
    return res.status(500).json({ error: 'internal server error' });
  }
});

// ── External Cron (Upstash QStash) — PRIMARY scheduler ─────────────────────
// Setup: https://console.upstash.com/qstash → New Schedule
// URL:      https://YOUR-APP.railway.app/trigger-daily
// Method:   POST
// Schedule: 0 7 * * *   (07:00 UTC = 10:00 Israel)
// Headers:  x-call-token: <CALL_TOKEN>
// ─────────────────────────────────────────────────────────────────────────────
app.post('/trigger-daily', async (req, res) => {
  const token = req.headers['x-call-token'] || req.query.token;
  if (token !== CALL_TOKEN) {
    console.warn('⚠️  /trigger-daily: unauthorized attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  console.log('⏰ External trigger: daily calls starting…');
  res.json({ ok: true, message: 'Daily calls triggered' }); // respond before async work

  (async () => {
    try {
      const users = await getAllUsers();
      console.log(`📞 Calling ${users.length} active user(s)`);
      for (const user of users) {
        try {
          await callUser(user);
        } catch (e) {
          console.error(`❌ Failed for ${user.name}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 5000));
      }
      console.log('✅ Daily call loop complete');
    } catch (err) {
      console.error('❌ trigger-daily loop error:', err.message);
    }
  })();
});

// ── Daily cron — FALLBACK (primary is Upstash external trigger above) ────────
// Keep as safety net for local dev or if Upstash is unavailable.
cron.schedule('0 7 * * *', async () => {
  console.log('⏰ [cron fallback] Daily calls starting…');
  try {
    const users = await getAllUsers();
    console.log(`📞 [cron] Calling ${users.length} active user(s)`);
    for (const user of users) {
      try {
        await callUser(user);
      } catch (e) {
        console.error(`❌ [cron] Failed for ${user.name}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    console.log('✅ [cron fallback] Daily call loop complete');
  } catch (err) {
    console.error('❌ [cron fallback] loop error:', err.message);
  }
}, { timezone: 'Asia/Jerusalem' });

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌿 צל on port ${PORT}`);
  console.log(`🗄️  Supabase: ${SUPABASE_URL}`);
  console.log(`🤖 Assistant: ${ASSISTANT_ID}`);
  if (!VAPI_KEY)     console.warn('⚠️  VAPI_API_KEY missing');
  if (!SUPABASE_KEY) console.warn('⚠️  SUPABASE_SERVICE_KEY missing');
});

// deploy trigger Thu Sep 10 04:34:29 PM UTC 2026

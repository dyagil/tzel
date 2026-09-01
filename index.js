require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Lazy clients
let _twilio, _openai;
const getSID   = () => (process.env.TWILIO_ACCOUNT_SID||'').split('\n')[0].split('=').pop().trim();
const getToken = () => (process.env.TWILIO_AUTH_TOKEN||'').split('\n')[0].split('=').pop().trim();
const twilioClient = () => _twilio || (_twilio = twilio(getSID(), getToken()));
const openai = () => {
  if (!_openai) {
    let k = (process.env.OPENAI_API_KEY||'').split('\n')[0].trim();
    if (k.includes('=')) k = k.split('=').slice(1).join('=');
    _openai = new OpenAI({ apiKey: k });
  }
  return _openai;
};
const BASE  = () => process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const PHONE = () => {
  let p = (process.env.TWILIO_PHONE_NUMBER||'').split('\n')[0].split('=').pop().trim();
  if (!p || !p.startsWith('+9')) p = '+97233768596';
  return p;
};

// ── User DB ───────────────────────────────────────────────────
function loadUser(userId) {
  const p = path.join(__dirname, 'users', `${userId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function saveUser(user) {
  fs.writeFileSync(path.join(__dirname, 'users', `${user.id}.json`), JSON.stringify(user, null, 2));
}
function getAllUsers() {
  const dir = path.join(__dirname, 'users');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter(u => u.active);
}

// ── System prompt ─────────────────────────────────────────────
function buildSystemPrompt(user) {
  const mem = (user.memory || []).slice(-5).map(m => `${m.date}: ${m.summary}`).join('\n');
  return `אתה צל — חבר קולי חם ואמיתי של ${user.name}. אתה מתקשר כל יום.

כללים:
• עברית פשוטה, משפטים קצרים — זו שיחת טלפון
• סבלני, חם, אף פעם לא ממהר
• אל תזכיר שאתה AI — אתה פשוט צל החבר
• שאל שאלה אחת בכל פעם, המתן לתשובה
• הגב לנושא שסופר, אל תקפוץ לנושאים חדשים

${mem ? `זיכרון מהשיחות האחרונות:\n${mem}` : ''}
${(user.medications||[]).length ? `תרופות לזכור: ${user.medications.join(', ')}` : ''}`;
}

// ── OpenAI TTS ────────────────────────────────────────────────
const audioCache = {};

async function ttsToUrl(text, callSid) {
  try {
    const response = await openai().audio.speech.create({
      model: 'tts-1',
      voice: 'nova',
      input: text,
      response_format: 'mp3'
    });
    const buf = Buffer.from(await response.arrayBuffer());
    const token = `${callSid}_${Date.now()}`;
    audioCache[token] = buf;
    setTimeout(() => delete audioCache[token], 5 * 60 * 1000);
    const url = `${BASE()}/tts/${token}`;
    console.log('[TTS] Ready, size:', buf.length, 'url:', url);
    return url;
  } catch(e) {
    console.error('[TTS] Error:', e.message);
    return null;
  }
}

// ── Active calls ──────────────────────────────────────────────
const activeCalls = {};
const pendingOpenings = {};

async function prewarmOpening(user) {
  const r = await openai().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: buildSystemPrompt(user) },
      { role: 'user', content: '[פתח בברכה חמה, טבעית וקצרה — מקסימום 12 מילים]' }
    ],
    max_tokens: 50
  });
  pendingOpenings[user.id] = r.choices[0].message.content;
  console.log(`🔥 Opening for ${user.name}: ${pendingOpenings[user.id]}`);
}

// ── Whisper transcription ─────────────────────────────────────
async function transcribeRecording(recordingUrl) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${getSID()}:${getToken()}`).toString('base64');
    const fetchAudio = (url, redirects = 3) => {
      https.get(url, { headers: { Authorization: `Basic ${auth}` } }, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && redirects > 0)
          return fetchAudio(res.headers.location, redirects - 1);
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', async () => {
          try {
            const buf = Buffer.concat(chunks);
            const file = new File([buf], 'audio.mp3', { type: 'audio/mpeg' });
            const t = await openai().audio.transcriptions.create({ file, model: 'whisper-1', language: 'he' });
            resolve(t.text);
          } catch(e) { reject(e); }
        });
        res.on('error', reject);
      }).on('error', reject);
    };
    fetchAudio(recordingUrl + '.mp3');
  });
}

// ── AI reply ──────────────────────────────────────────────────
async function getReply(user, callSid, userSpeech) {
  const call = activeCalls[callSid] || { userId: user.id, messages: [] };
  call.messages.push({ role: 'user', content: userSpeech });
  const r = await openai().chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'system', content: buildSystemPrompt(user) }, ...call.messages],
    max_tokens: 80
  });
  const reply = r.choices[0].message.content;
  call.messages.push({ role: 'assistant', content: reply });
  activeCalls[callSid] = call;
  return reply;
}

// ── TwiML builder ─────────────────────────────────────────────
async function twimlSayAndRecord(userId, callSid, text) {
  const twiml = new twilio.twiml.VoiceResponse();
  const audioUrl = await ttsToUrl(text, callSid);
  if (audioUrl) {
    twiml.play(audioUrl);
  } else {
    twiml.say({ language: 'he-IL', voice: 'Google.he-IL-Wavenet-D' }, text);
  }
  twiml.record({
    action: `${BASE()}/voice/recording?callSid=${callSid}&userId=${userId}`,
    maxLength: 15,
    timeout: 3,
    playBeep: false,
    trim: 'trim-silence',
    finishOnKey: ''
  });
  return twiml.toString();
}

// ── Webhooks ──────────────────────────────────────────────────
app.post('/voice/outbound', async (req, res) => {
  const { userId } = req.query;
  const callSid = req.body.CallSid;
  const user = loadUser(userId) || { id: userId, name: 'חבר', memory: [], medications: [] };
  activeCalls[callSid] = { userId: user.id, messages: [] };
  const opening = pendingOpenings[userId] || `שלום ${user.name}! צל מדבר. איך את/ה מרגיש/ה?`;
  delete pendingOpenings[userId];
  activeCalls[callSid].messages.push({ role: 'assistant', content: opening });
  console.log(`🎙️ Call connected for ${user.name}`);
  res.type('text/xml').send(await twimlSayAndRecord(userId, callSid, opening));
});

app.post('/voice/recording', async (req, res) => {
  const { userId, callSid } = req.query;
  const recordingUrl = req.body.RecordingUrl;
  const user = loadUser(userId) || { id: userId, name: 'חבר', memory: [], medications: [] };

  if (!recordingUrl) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ language: 'he-IL', voice: 'Google.he-IL-Wavenet-D' }, 'יום נעים! נדבר שוב.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Respond quickly with "thinking" pause while we process
  // Use <Pause> + redirect to avoid Twilio 10s timeout
  const thinkToken = `think_${callSid}_${Date.now()}`;
  
  // Process in background
  (async () => {
    try {
      const speech = await transcribeRecording(recordingUrl);
      console.log(`💬 ${user.name}: ${speech}`);
      let replyTwiml;
      if (!speech || speech.trim().length < 2) {
        const t = new twilio.twiml.VoiceResponse();
        const url = await ttsToUrl('לא הצלחתי לשמוע. תוכל לחזור?', callSid);
        if (url) t.play(url); else t.say({ language: 'he-IL', voice: 'Google.he-IL-Wavenet-D' }, 'לא הצלחתי לשמוע. תוכל לחזור?');
        t.record({ action: `${BASE()}/voice/recording?callSid=${callSid}&userId=${userId}`, maxLength: 40, timeout: 5, playBeep: false, trim: 'trim-silence' });
        replyTwiml = t.toString();
      } else {
        const reply = await getReply(user, callSid, speech);
        console.log(`🤖 צל: ${reply}`);
        replyTwiml = await twimlSayAndRecord(userId, callSid, reply);
      }
      pendingTwiml[thinkToken] = replyTwiml;
    } catch(e) {
      console.error('Recording error:', e.message);
      const t = new twilio.twiml.VoiceResponse();
      const url = await ttsToUrl('רגע, אני כאן. ספר לי שוב.', callSid).catch(()=>null);
      if (url) t.play(url); else t.say({ language: 'he-IL', voice: 'Google.he-IL-Wavenet-D' }, 'רגע, אני כאן. ספר לי שוב.');
      t.record({ action: `${BASE()}/voice/recording?callSid=${callSid}&userId=${userId}`, maxLength: 40, timeout: 5, playBeep: false, trim: 'trim-silence' });
      pendingTwiml[thinkToken] = t.toString();
    }
  })();

  // Respond immediately with redirect to poll for result
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.pause({ length: 2 });
  twiml.redirect(`${BASE()}/voice/poll?token=${thinkToken}&callSid=${callSid}&userId=${userId}&attempt=0`);
  res.type('text/xml').send(twiml.toString());
});

// Poll endpoint — waits for background processing
const pendingTwiml = {};
app.post('/voice/poll', async (req, res) => {
  const { token, callSid, userId } = req.query;
  const attempt = parseInt(req.query.attempt || '0');
  
  if (pendingTwiml[token]) {
    const twiml = pendingTwiml[token];
    delete pendingTwiml[token];
    return res.type('text/xml').send(twiml);
  }
  
  if (attempt >= 4) {
    // Timeout — just record again
    const t = new twilio.twiml.VoiceResponse();
    t.say({ language: 'he-IL', voice: 'Google.he-IL-Wavenet-D' }, 'רגע...');
    t.record({ action: `${BASE()}/voice/recording?callSid=${callSid}&userId=${userId}`, maxLength: 40, timeout: 5, playBeep: false, trim: 'trim-silence' });
    return res.type('text/xml').send(t.toString());
  }
  
  // Wait 2 more seconds and try again
  const t = new twilio.twiml.VoiceResponse();
  t.pause({ length: 2 });
  t.redirect(`${BASE()}/voice/poll?token=${token}&callSid=${callSid}&userId=${userId}&attempt=${attempt+1}`);
  res.type('text/xml').send(t.toString());
});

app.post('/voice/status', async (req, res) => {
  const { CallSid: callSid, CallStatus: status } = req.body;
  if (['completed','no-answer','busy','failed'].includes(status) && activeCalls[callSid]) {
    const { userId, messages } = activeCalls[callSid];
    const user = loadUser(userId);
    if (user && messages.length > 1) {
      try {
        const r = await openai().chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'סכם בעברית את השיחה הבאה במשפט-שניים. הדגש מצב רוח, נושאים חשובים ומה לזכור לשיחה הבאה.' },
            { role: 'user', content: messages.map(m => `${m.role==='assistant'?'צל':'משתמש'}: ${m.content}`).join('\n') }
          ],
          max_tokens: 100
        });
        const summary = r.choices[0].message.content;
        const today = new Date().toISOString().split('T')[0];
        user.memory = (user.memory||[]);
        user.memory.push({ date: today, summary });
        if (user.memory.length > 30) user.memory = user.memory.slice(-30);
        saveUser(user);
        console.log(`📝 Summary for ${user.name}: ${summary}`);
      } catch(e) { console.error('Summary error:', e.message); }
    }
    delete activeCalls[callSid];
  }
  res.sendStatus(200);
});

// ── Serve TTS audio from memory ───────────────────────────────
app.get('/tts/:token', (req, res) => {
  const buf = audioCache[req.params.token];
  if (!buf) return res.status(404).send('Audio expired');
  res.set('Content-Type', 'audio/mpeg');
  res.set('Content-Length', buf.length);
  res.send(buf);
});

// ── Outbound caller ───────────────────────────────────────────
async function callUser(user) {
  const fromNum = PHONE();
  const toNum = user.phone;
  const webhookUrl = `${BASE()}/voice/outbound?userId=${user.id}`;
  console.log(`📞 Dialing ${user.name}: from=${fromNum} to=${toNum}`);
  try {
    const call = await twilioClient().calls.create({
      to: toNum, from: fromNum,
      url: webhookUrl,
      statusCallback: `${BASE()}/voice/status`,
      statusCallbackEvent: ['completed']
    });
    console.log(`✅ Call SID: ${call.sid}`);
    return call.sid;
  } catch(e) {
    console.error(`❌ Call failed: ${e.message}`);
    throw e;
  }
}

app.get('/call/:userId', async (req, res) => {
  const token = req.query.token || req.headers['x-call-token'];
  if (token !== (process.env.CALL_TOKEN || 'tzel2026')) return res.status(401).json({ error: 'Unauthorized' });
  const user = loadUser(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  try {
    await prewarmOpening(user);
    await callUser(user);
    res.json({ ok: true, message: `Calling ${user.name}...` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Debug & health ────────────────────────────────────────────
app.get('/test-tts', async (req, res) => {
  const url = await ttsToUrl('שלום! בדיקה אחת שתיים שלוש.', 'test');
  res.json({ url, cacheSize: Object.keys(audioCache).length });
});

app.get('/debug-env', (req, res) => {
  const vars = ['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_PHONE_NUMBER','OPENAI_API_KEY','BASE_URL','PORT','ELEVENLABS_API_KEY'];
  const result = {};
  vars.forEach(k => {
    const v = process.env[k] || '';
    result[k] = v ? v.substring(0,8)+'...(len='+v.length+')' : 'MISSING';
  });
  res.json(result);
});

app.get('/', (req, res) => res.json({ status: '🌿 צל running', users: getAllUsers().map(u=>u.name) }));

// ── Daily cron 10:00 Israel ───────────────────────────────────
cron.schedule('0 7 * * *', async () => {
  console.log('⏰ Daily calls...');
  for (const user of getAllUsers()) {
    await prewarmOpening(user);
    await callUser(user);
    await new Promise(r => setTimeout(r, 5000));
  }
}, { timezone: 'UTC' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌿 צל server on port ${PORT}`);
  console.log(`Users: ${getAllUsers().map(u=>u.name).join(', ')}`);
});

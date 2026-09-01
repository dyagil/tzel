# 🔧 ארכיטקטורה טכנית — CompanionAI

## Stack MVP (עדכון 2026-09-01 — Vapi.ai)

| שכבה | כלי | למה |
|---|---|---|
| **Voice AI Platform** | **Vapi.ai** | מאחד STT+LLM+TTS+telephony בAPI אחד |
| שיחות קוליות | **Twilio** (דרך Vapi) | מספר קיים +97233768596, Vapi מנהל |
| AI / שיחה | **GPT-4o** (דרך Vapi) | prompt override per-user עם זיכרון |
| STT | **Deepgram nova-2** (multi) | תמלול עברית |
| TTS | **Azure he-IL-AvriNeural** | קול עברי טבעי |
| זיכרון | **JSON file per user** (MVP) → לאחר מכן DB | פשוט ומהיר להתחיל |
| Scheduling | **node-cron** | מתקשר בשעה קבועה כל יום |
| משפחה | **WhatsApp (Twilio API)** | סיכום יומי + הודעות מהמשפחה |
| Backend | **Node.js / Express** | מה שדייוויד כבר עובד איתו |
| Hosting | **Railway / Render** (MVP) | הכי מהיר להעלות |

## IDs קריטיים
- **Assistant ID:** `90fd41b7-c955-4450-a1b0-99cab3230923`
- **Phone Number ID:** `b26d6bd1-f199-43da-902a-ee86e36a8170`
- **Phone Number:** `+97233768596`

---

## Flow בסיסי

```
[cron 10:00] → Twilio מחייג לקשיש
    → קשיש עונה
    → GPT-4o Realtime מנהל שיחה בעברית
    → שיחה נגמרת → נשמר סיכום
    → WhatsApp נשלח למשפחה עם סיכום
    → [אם לא ענה] → ניסיון שני אחרי שעה
```

---

## זיכרון — מבנה

```json
{
  "userId": "david_grandma",
  "name": "רות",
  "age": 83,
  "medications": ["אספירין 09:00", "ביסופרולול 20:00"],
  "family": {
    "primaryContact": "+972526204608",
    "whatsappGroup": "..."
  },
  "memory": [
    {
      "date": "2026-09-01",
      "summary": "סיפרה שהנכד גיל בא לבקר. כאבים ברגל שמאל. מצב רוח טוב.",
      "callDuration": 420
    }
  ],
  "preferences": {
    "callTime": "10:00",
    "language": "he",
    "personality": "warm_grandma"
  }
}
```

---

## עלויות משוערות MVP

| שירות | עלות משוערת |
|---|---|
| Twilio Voice | ~$0.02/דקה → ~₪3/יום לקשיש |
| OpenAI GPT-4o | ~$0.06/דקה → ~₪8/יום לקשיש |
| WhatsApp | ~$0.005/הודעה |
| Hosting | ~$5/חודש |
| **סה"כ לקשיש/חודש** | **~₪200-300** |

→ תמחור של ₪299/חודש = רווחי מהיום הראשון

---

## שלבים עתידיים (post-MVP)
- פאנל ניהול למשפחה (ווב)
- זיהוי חריגות (לא ענה 2 ימים → התראה)
- שילוב עם בתי אבות (API / CRM)
- אפליקציה native למשפחה
- הרחבה לשוק בינלאומי

require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json());

const {
  PORT = 3000,
  OPENAI_API_KEY,
  MARKETO_BASE_URL,
  MARKETO_CLIENT_ID,
  MARKETO_CLIENT_SECRET,
  WEBHOOK_SECRET,
} = process.env;

// In-memory Marketo token cache
let marketoToken = null;
let marketoTokenExpiresAt = 0;

// Dummy base data – in real life uit DB / config
const BASE_DATA = {
  VC_BASE_V1: {
    productName: 'Voice Cloud',
    coreBenefits: [
      'Altijd bereikbaar, ook als je niet op kantoor bent',
      'Eenvoudige bediening via app en web',
      'Schaalbaar per medewerker, groei mee met je zaak',
    ],
    primaryCTA: 'Plan een gratis demo',
    ctaUrl: 'https://www2.telenet.be/business/nl/voice-cloud/demo',
  },
};

// --- Marketo helpers ---

async function getMarketoAccessToken() {
  const now = Date.now();
  if (marketoToken && now < marketoTokenExpiresAt) {
    return marketoToken;
  }

  const url =
    `${MARKETO_BASE_URL}/identity/oauth/token` +
    `?grant_type=client_credentials` +
    `&client_id=${encodeURIComponent(MARKETO_CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(MARKETO_CLIENT_SECRET)}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    console.error('Marketo token error:', text);
    throw new Error('Failed to get Marketo access token');
  }

  const data = await res.json();
  marketoToken = data.access_token;
  // marge aftrekken
  marketoTokenExpiresAt = now + (data.expires_in - 300) * 1000;

  return marketoToken;
}

async function updateMarketoLead(marketoLeadId, fields) {
  const token = await getMarketoAccessToken();
  const url = `${MARKETO_BASE_URL}/rest/v1/leads.json`;

  const body = {
    action: 'updateOnly',
    lookupField: 'id',
    input: [
      {
        id: marketoLeadId,
        ...fields,
      },
    ],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok || (data && data.errors && data.errors.length)) {
    console.error('Marketo update error:', JSON.stringify(data));
    throw new Error('Failed to update Marketo lead');
  }

  return data;
}

// --- Prompt helpers ---

function buildSystemPrompt(language = 'nl') {
  if (language === 'nl') {
    return `
Je bent een e-mailcopywriter voor Telenet Business.
Je schrijft in het Nederlands, professioneel maar vlot, duidelijk en kort.
Gebruik maximaal 120 tekens voor de subject line en 120 tekens voor de preheader.
Gebruik eenvoudige HTML met inline styles, zonder <style> of <script>.
Gebruik {{lead.First Name}} als placeholder voor de voornaam.
De e-mail is bedoeld om leads te overtuigen een volgende stap te zetten.
Output ALTIJD exact in geldig JSON-formaat (één object), zonder extra tekst.`;
  }

  return `
You are an email copywriter for Telenet Business.
Write in clear, concise, professional language.
Max 120 characters for subject and 120 for preheader.
Use simple HTML with inline styles only, no <style> or <script>.
Use {{lead.First Name}} as the placeholder for the first name.
Output MUST be a single valid JSON object, nothing else.`;
}

function buildUserPrompt({ sector, employeeCount, jobTitle, language, base }) {
  return `
Schrijf een commerciële e-mail voor een lead met deze kenmerken:
- Sector: ${sector || 'onbekend'}
- Aantal werknemers: ${employeeCount || 'onbekend'}
- Jobtitel: ${jobTitle || 'onbekend'}
- Taal: ${language || 'nl'}

De e-mail gaat over het product "${base.productName}".

Belangrijkste voordelen die in de e-mail moeten terugkomen (vertaal en herschrijf in jouw eigen woorden):
${base.coreBenefits.map((b, i) => `  ${i + 1}. ${b}`).join('\n')}

Call-to-action:
- Tekst: ${base.primaryCTA}
- Url: ${base.ctaUrl}

Structuur van de e-mail:
- Aanspreking met {{lead.First Name}}
- 1 korte intro die inspeelt op sector en jobtitel
- 2 à 3 korte alinea's met voordelen
- 1 duidelijke call-to-action button met link naar ${base.ctaUrl}
- Eventueel 1 korte afsluiter

BELANGRIJK:
Geef de output als één JSON-object met deze structuur:

{
  "subject": "…",
  "preheader": "…",
  "htmlBody": "<!DOCTYPE html>…</html>"
}

Zorg dat htmlBody volledige, geldige HTML bevat (met <html>, <body>, …).
Geen extra tekst rond de JSON, geen uitleg. Enkel het JSON-object.`;
}


async function generateEmailWithAI({
  sector,
  employeeCount,
  jobTitle,
  language = 'nl',
  baseDataId,
}) {
  const base = BASE_DATA[baseDataId];
  if (!base) {
    throw new Error(`Onbekende baseDataId: ${baseDataId}`);
  }

  const systemPrompt = buildSystemPrompt(language);
  const userPrompt = buildUserPrompt({
    sector,
    employeeCount,
    jobTitle,
    language,
    base,
  });

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      // extra hint naar JSON-only
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('OpenAI error raw:', text);
    throw new Error('Failed to call OpenAI');
  }

  const data = await res.json();
  let content = data.choices[0].message.content;

  console.log('OpenAI raw content:', content);

  // --- CLEANUP STAP 1: code fences weghalen (```json ... ```)
  // Als de AI toch in een codeblock antwoordt
  if (content.trim().startsWith('```')) {
    // verwijder eerste ```... regel
    content = content.replace(/^```[a-zA-Z]*\s*/, '');
    // verwijder laatste ```
    content = content.replace(/```$/, '').trim();
  }

  // --- CLEANUP STAP 2: enkel het stuk tussen eerste { en laatste } nemen
  const firstCurly = content.indexOf('{');
  const lastCurly = content.lastIndexOf('}');

  if (firstCurly === -1 || lastCurly === -1 || lastCurly <= firstCurly) {
    console.error('OpenAI content lijkt geen JSON object te bevatten:', content);
    throw new Error('OpenAI output bevat geen geldig JSON-object');
  }

  const jsonSlice = content.slice(firstCurly, lastCurly + 1);

  let parsed;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (e) {
    console.error('JSON parse error op slice:', jsonSlice);
    console.error('Volledige content:', content);
    throw new Error(
      'OpenAI output is geen zuiver JSON (zie logs voor details)'
    );
  }

  if (!parsed.subject || !parsed.preheader || !parsed.htmlBody) {
    console.error('OpenAI JSON mist verplichte velden:', parsed);
    throw new Error('OpenAI JSON mist subject/preheader/htmlBody');
  }

  return parsed;
}


// --- Routes ---

app.get('/', (req, res) => {
  res.send('AI → Marketo webhook is running');
});

app.post('/webhooks/ai-email', async (req, res) => {
  try {
    // simpele header security
    if (WEBHOOK_SECRET && req.headers['x-webhook-key'] !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      email,
      marketoLeadId,
      sector,
      employeeCount,
      jobTitle,
      language = 'nl',
      baseDataId = 'VC_BASE_V1',
    } = req.body;

    if (!marketoLeadId) {
      return res.status(400).json({ error: 'marketoLeadId is verplicht' });
    }

    const aiEmail = await generateEmailWithAI({
      sector,
      employeeCount,
      jobTitle,
      language,
      baseDataId,
    });

    const fieldsToUpdate = {
      AI_Email_Subject__c: aiEmail.subject,
      AI_Email_Preheader__c: aiEmail.preheader,
      AI_Email_Body_HTML__c: aiEmail.htmlBody,
      AI_Email_Language__c: language,
      AI_Email_Ready__c: true,
    };

    const mktoResponse = await updateMarketoLead(marketoLeadId, fieldsToUpdate);

    res.json({
      success: true,
      message: 'AI email gegenereerd en in Marketo gezet',
      aiEmail,
      marketo: mktoResponse,
    });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

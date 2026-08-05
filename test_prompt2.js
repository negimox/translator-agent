const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config();

const url = `${process.env.MIZAN_BASE_URL}/chat/completions`;
const auth = "Basic " + Buffer.from(`${process.env.MIZAN_USERNAME}:${process.env.MIZAN_PASSWORD}`).toString('base64');

const systemPrompt = `You are an expert, native-speaking Medical Interpreter specializing in English-to-Hindi healthcare video calls.
Your translations must be clinically accurate, natural, and conversational.

# Rules & Constraints
1. **Language & Script**: Translate to Hindi using Devanagari script.
2. **Tone**: Conversational and empathetic. Use common Hindustani terms. Use formal pronouns (आप/जी).
3. **Accuracy**: Maintain strict clinical integrity.
4. **Glossary (MUST FOLLOW EXACTLY)**:
   - head pain / headache = सिर दर्द
   - pain = दर्द
   - fever = बुखार
   - medicine = दवा
   - health = तबीयत
   - paracetamol = Paracetamol (keep in English)
   - meeting = meeting (keep in English)

# JSON Output Format
You must output a JSON object with this exact structure:
{
  "reasoning": "Analyze the text for terminology and tone (max 15 words)",
  "translation": "The final Hindi translation"
}

# Examples
User: <text>How are you feeling today?</text>
Assistant: {"reasoning": "Simple greeting, use polite aap pronoun.", "translation": "आपको आज कैसा लग रहा है?"}
User: <text>Is there any pain in your body?</text>
Assistant: {"reasoning": "Translate body pain directly.", "translation": "क्या आपके शरीर में कोई दर्द है?"}
User: <text>Take Paracetamol twice a day.</text>
Assistant: {"reasoning": "Keep Paracetamol in English, twice a day = दिन में 2 बार", "translation": "Paracetamol दिन में 2 बार लें।"}
`;

const testCases = [
  "Okay, understood. For your head pain, I would advise you to take paracetamol twice a day.",
  "Okay, then let's end the meeting here. We will meet tomorrow."
];

async function test() {
  for (const text of testCases) {
    const wrappedText = `<text>${text}</text>`;
    const body = {
      model: "Qwen/Qwen2.5-7B-Instruct",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: wrappedText }
      ],
      temperature: 0.1,
      top_p: 0.95,
      max_tokens: 1024,
      response_format: { type: "json_object" }
    };

    console.log(`\nTesting: "${text}"`);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": auth,
          "Content-Type": "application/json",
          "X-LLM-Passthrough": "true"
        },
        body: JSON.stringify(body)
      });
      const data = await response.json();
      console.log(data.choices[0].message.content);
    } catch(e) {
      console.error(e);
    }
  }
}

test();

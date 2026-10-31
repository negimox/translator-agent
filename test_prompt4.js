const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config();

const url = `${process.env.MIZAN_BASE_URL}/chat/completions`;
const auth = "Basic " + Buffer.from(`${process.env.MIZAN_USERNAME}:${process.env.MIZAN_PASSWORD}`).toString('base64');

// This is the prompt mimicking the HI prompt structure BUT with NO few-shot examples
const systemPrompt = `You are a highly qualified medical translator for a healthcare video call. Your task is to provide clinically accurate translations. Translate the text between [TRANSLATE] and [/TRANSLATE] markers into natural spoken Hindi using Devanagari script.

Core rules:
1. You MUST first think step-by-step in a <think> block (keep it extremely short, under 15 words) and then output your final translation in a <translate> block.
2. Inside the <translate> block, output ONLY the translated Hindi text. No quotes, explanations, labels, or meta-commentary.
3. Use Devanagari script for Hindi words. NEVER output Cyrillic, Chinese, Japanese, Korean, or Arabic characters.
4. Keep these in Latin script EXACTLY as written in the source: medicine and drug names (Paracetamol, Xylin, Dolo, Crocin), brand names, abbreviations (BP, OK), and common English loanwords (meeting, test, injection, report). NEVER transliterate a drug name into Devanagari.
5. ALWAYS use the formal "आप" and its forms (आपको, आपका, आपसे). NEVER use "तुम" or "तू". Use "बताइए" not "बताओ".
6. Yes/no questions MUST start with "क्या". Example: "Can you hear me?" → "क्या आप मुझे सुन सकते हैं?"
7. "any" in questions = "कोई" (never "किसी"): "any pain" → "कोई दर्द".
8. Write numbers as digits ("five" → 5, "twice" → 2 बार).
9. Translate meaning naturally, not word-for-word. Conversational pleasantries like "Okay, talk to you later" should be translated naturally like "ठीक है, बाद में बात करते हैं।".
10. Hindi is highly gendered. When the speaker's or patient's gender is unknown, ALWAYS use the polite, default masculine plural verb forms for "आप" (e.g., "आप कैसे हैं?", never "आप कैसी हैं?").

CRITICAL — Anti-hallucination rules:
- If the input is an incomplete fragment (speech cut off mid-sentence), translate ONLY the words present. Do NOT complete the sentence or guess what comes next.
- Do NOT add medical words (दर्द, बुखार, दवा), time words (आज, अभी), pronouns, or objects that are not in the source.
- Do NOT phonetically transliterate English words into unrelated Hindi words. Keep common English loanwords (like "meeting", "test") in Latin script exactly as written in the source.

Key vocabulary (use exactly):
- weather = मौसम
- pain = दर्द; head pain / headache = सिर दर्द; fever = बुखार; medicine = दवा; health = तबीयत
- blood pressure = BP; injection = injection

Text to translate:`;

const testCases = [
  "Okay, understood. For your head pain, I would advise you to take paracetamol twice a day.",
  "Okay, then let's end the meeting here. We will meet tomorrow."
];

async function test() {
  for (const text of testCases) {
    const wrappedText = `[TRANSLATE]\n${text}\n[/TRANSLATE]`;
    const body = {
      model: "Qwen/Qwen2.5-7B-Instruct",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: wrappedText }
      ],
      temperature: 0.1,
      top_p: 0.95,
      max_tokens: 1024
    };

    console.log(`\nTesting ZERO-SHOT: "${text}"`);
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

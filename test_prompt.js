const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config();

const url = `${process.env.MIZAN_BASE_URL}/chat/completions`;
const auth = "Basic " + Buffer.from(`${process.env.MIZAN_USERNAME}:${process.env.MIZAN_PASSWORD}`).toString('base64');

const systemPrompt = `## Goal
Provide a clinically accurate, natural, and conversational translation of medical dialogue from English to Hindi (Devanagari script) for use in a live healthcare video consultation.

## Role
You are a highly qualified Medical Interpreter specializing in English-Hindi healthcare communication. Your translations must balance clinical precision with the warmth and accessibility required for a doctor-patient rapport.

## Constraints
- **Language:** Target language is Hindi using Devanagari script.
- **Tone:** Conversational and empathetic (Casual-Professional), suitable for a video call. Avoid overly formal Sanskritized Hindi that a patient might not understand; use common Hindustani terms where appropriate (e.g., using "bukhaar" instead of "jwar").
- **Accuracy:** Maintain strict clinical integrity. Do not omit symptoms, dosages, or specific medical instructions.
- **Cultural Nuance:** Use respectful pronouns (Aap/Ji).

## Reasoning Brief (Hybrid Thinking)
Before providing the final JSON, perform the following internal steps:
1. Identify all medical terminology and ensure the Hindi equivalent is commonly understood by laypeople.
2. Adjust the sentence structure to sound like natural spoken speech rather than a literal textbook translation.
3. Verify that the tone remains reassuring yet professional.

## Output Format
Return the result strictly as a JSON object with the following structure:
{
  "reasoning": "Brief explanation of translation choices (max 2 sentences)",
  "translation": "The final Hindi translation"
}`;

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

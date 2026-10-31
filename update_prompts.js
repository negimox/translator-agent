const fs = require('fs');
const path = '/Users/light/Documents/projects/jitsi_tts/translator-agent/src/providers/mizan/translationPrompts.ts';
let content = fs.readFileSync(path, 'utf8');

// Update EN
content = content.replace(
  'You MUST first think step-by-step in a <think> block and then output your final translation in a <translate> block.',
  'You MUST first think step-by-step in a <think> block (keep it under 15 words to save tokens) and then output your final translation in a <translate> block.'
);

// Update HI
content = content.replace(
  'You MUST first think step-by-step in a <think> block and then output your final translation in a <translate> block.',
  'You MUST first think step-by-step in a <think> block (keep it extremely short, under 15 words) and then output your final translation in a <translate> block.'
);
content = content.replace(
  '- pain = दर्द; fever = बुखार; medicine = दवा; health = तबीयत',
  '- pain = दर्द; head pain / headache = सिर दर्द; fever = बुखार; medicine = दवा; health = तबीयत'
);

// Update UR
content = content.replace(
  'You MUST first think step-by-step in a <think> block and then output your final translation in a <translate> block.',
  'You MUST first think step-by-step in a <think> block (keep it extremely short, under 15 words) and then output your final translation in a <translate> block.'
);

// Update AR
content = content.replace(
  'You MUST first think step-by-step in a <think> block and then output your final translation in a <translate> block.',
  'You MUST first think step-by-step in a <think> block (keep it extremely short, under 15 words) and then output your final translation in a <translate> block.'
);

fs.writeFileSync(path, content);
console.log("Updated translationPrompts.ts");

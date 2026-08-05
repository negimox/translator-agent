const fs = require('fs');
const log = fs.readFileSync('/Users/light/Documents/projects/jitsi_tts/translator-agent/logs/meeting_23.log', 'utf8').split('\n');
const stt = {};
const trans = {};
for (const line of log) {
  if (line.includes('STT completed')) {
    const match = line.match(/(\{.*\})/);
    if (match) {
      try {
        const json = JSON.parse(match[1]);
        stt[json.chunkId] = json.transcription;
      } catch(e) {}
    }
  }
  if (line.includes('Translation completed (Mizan)')) {
    const match = line.match(/(\{.*\})/);
    if (match) {
      try {
        const json = JSON.parse(match[1]);
        trans[json.chunkId] = json.translation;
      } catch(e) {}
    }
  }
}

for (const id in stt) {
  if (trans[id]) {
    console.log(`[${id}]`);
    console.log(`STT: ${stt[id]}`);
    console.log(`LLM: ${trans[id]}`);
    console.log('---');
  }
}

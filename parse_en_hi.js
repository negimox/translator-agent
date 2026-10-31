const fs = require('fs');
const lines = fs.readFileSync('/Users/light/Documents/projects/jitsi_tts/translator-agent/logs/meeting_22.log', 'utf8').split('\n');
const stt = {};
for (const line of lines) {
  if (line.includes('STT completed') && line.includes('"chunkId":"translator-hi-')) {
    const match = line.match(/(\{.*\})/);
    if (match) {
      try {
        const json = JSON.parse(match[1]);
        stt[json.chunkId] = json.transcription;
      } catch(e){}
    }
  }
  if (line.includes('Translation completed') && line.includes('"chunkId":"translator-hi-')) {
    const match = line.match(/(\{.*\})/);
    if (match) {
      try {
        const json = JSON.parse(match[1]);
        if (stt[json.chunkId]) {
          console.log(`STT: ${stt[json.chunkId]}\nTRN: ${json.translation}\n`);
        }
      } catch(e){}
    }
  }
}

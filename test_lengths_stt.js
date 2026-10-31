const fs = require('fs');
const lines = fs.readFileSync('/Users/light/Documents/projects/jitsi_tts/translator-agent/logs/meeting_22.log', 'utf8').split('\n');
for (const line of lines) {
  if (line.includes('STT completed') && line.includes('{"chunkId"')) {
    const match = line.match(/(\{.*\})/);
    if (match) {
      try {
        const json = JSON.parse(match[1]);
        if (json.transcription && json.transcription.length < 10) {
          console.log(json.chunkId, json.transcription);
        }
      } catch(e){}
    }
  }
}

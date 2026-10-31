const fs = require('fs');
const lines = fs.readFileSync('/Users/light/Documents/projects/jitsi_tts/translator-agent/logs/meeting_22.log', 'utf8').split('\n');
for (const line of lines) {
  if (line.includes('Translation completed') && line.includes('{"chunkId"')) {
    const match = line.match(/(\{.*?\})/);
    if (match) {
      try {
        const json = JSON.parse(match[1]);
        if (json.translation && json.translation.length < 10) {
          console.log(json.chunkId, json.translation);
        }
      } catch(e){}
    }
  }
}

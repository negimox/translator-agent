const fs = require('fs');
const lines = fs.readFileSync('/Users/light/Documents/projects/jitsi_tts/translator-agent/logs/meeting_22.log', 'utf8').split('\n');
for (const line of lines) {
  if (line.includes('STT request completed')) {
    const match = line.match(/(\{.*\})/);
    if (match) {
      try {
        const json = JSON.parse(match[1]);
        if (json.textLength > 0) {
          console.log(`Lang: ${json.detectedLanguage}, Conf: ${json.confidence}, TextLen: ${json.textLength}`);
        }
      } catch(e){}
    }
  }
}

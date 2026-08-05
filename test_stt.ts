import WebSocket from "ws";
import * as dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
    console.error("No ELEVENLABS_API_KEY");
    process.exit(1);
}

const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime`;
const ws = new WebSocket(url, {
    headers: {
        "xi-api-key": apiKey,
    }
});

ws.on("open", () => {
    console.log("Opened!");
});

ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    console.log("Message:", msg);
    
    if (msg.message_type === "session_started") {
        // Send a dummy audio chunk (e.g. 0.1s of silence at 16kHz PCM = 1600 samples * 2 bytes = 3200 bytes)
        const dummyAudio = Buffer.alloc(3200);
        ws.send(JSON.stringify({
            // user_audio_chunk: dummyAudio.toString("base64")
            // Let's test the official STT format only
            message_type: "input_audio_chunk",
            audio_base_64: dummyAudio.toString("base64")
        }));
        
        setTimeout(() => {
            process.exit(0);
        }, 2000);
    }
});

ws.on("close", (code, reason) => {
    console.log("Closed:", code, reason.toString());
});

ws.on("error", (err) => {
    console.error("Error:", err);
});

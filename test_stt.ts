import WebSocket from "ws";
import * as dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
    console.error("No ELEVENLABS_API_KEY");
    process.exit(1);
}

const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&vad_commit_strategy=true`;
const ws = new WebSocket(url, {
    headers: {
        "xi-api-key": apiKey,
    }
});

ws.on("open", () => {
    console.log("Opened!");
});

ws.on("message", (data) => {
    console.log("Message:", data.toString());
    process.exit(0);
});

ws.on("close", (code, reason) => {
    console.log("Closed:", code, reason.toString());
});

ws.on("error", (err) => {
    console.error("Error:", err);
});

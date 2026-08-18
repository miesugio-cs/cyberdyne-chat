import "dotenv/config";
import http from "node:http";
import { google } from "googleapis";

const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;

const clientId = process.env.YOUTUBE_CLIENT_ID;
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env first.");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/youtube.upload"],
});

console.log("\n以下のURLをブラウザで開いて、アップロード先のYouTubeチャンネルのGoogleアカウントでログイン・許可してください:\n");
console.log(authUrl, "\n");
console.log(`許可後 http://127.0.0.1:${PORT} にリダイレクトされます。このプロセスはそれを待ち受けています…`);

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith("/oauth2callback")) {
    res.writeHead(404).end();
    return;
  }

  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");

  if (!code) {
    res.writeHead(400).end("code がありません");
    return;
  }

  const { tokens } = await oauth2Client.getToken(code);

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<h1>認証完了</h1>ターミナルに戻ってください。このタブは閉じて大丈夫です。");

  console.log("\n取得できたリフレッシュトークン(これを .env の YOUTUBE_REFRESH_TOKEN に保存):\n");
  console.log(tokens.refresh_token);
  console.log("");

  server.close();
  process.exit(0);
});

server.listen(PORT);

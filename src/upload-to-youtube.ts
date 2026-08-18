import "dotenv/config";
import fs from "node:fs";
import { google } from "googleapis";

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  let file: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      args[a.slice(2)] = argv[i + 1];
      i++;
    } else if (!file) {
      file = a;
    }
  }

  return { file, title: args.title, publishAt: args.publishAt };
}

async function main() {
  const { file, title, publishAt } = parseArgs(process.argv.slice(2));

  if (!file || !title || !publishAt) {
    console.error(
      "使い方: npm run upload -- <動画ファイルパス> --title <仮タイトル> --publishAt <公開予約日時 ISO8601, 例 2026-08-18T10:45:00Z>"
    );
    process.exit(1);
  }

  if (!fs.existsSync(file)) {
    console.error(`ファイルが見つかりません: ${file}`);
    process.exit(1);
  }

  const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN } = process.env;
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
    console.error("YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN を .env に設定してください(先に npm run auth)。");
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });

  const youtube = google.youtube({ version: "v3", auth: oauth2Client });

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title,
        categoryId: "22",
      },
      status: {
        privacyStatus: "private",
        publishAt,
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: fs.createReadStream(file),
    },
  });

  console.log(`アップロード完了: https://studio.youtube.com/video/${res.data.id}/edit`);
  console.log(`公開予約: ${publishAt}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

# note-shorts-uploader

noteの記事に誘導するYouTubeショート動画の、Canvaでの書き出しとYouTubeへのアップロード(公開予約つき)だけを自動化する小さなツール。

台本作成・Canvaへの文字反映はこのリポジトリの範囲外(Claude Codeとのチャットで行う)。詳しい運用フローは [AGENTS.md](./AGENTS.md) を参照。

## セットアップ

1. 依存関係をインストール

   ```bash
   npm install
   ```

2. `.env.example` を `.env` にコピーし、[Google Cloud Console](https://console.cloud.google.com/) で作成したOAuthクライアント(種類: デスクトップアプリ)の `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` を入力する(手順は `.env.example` のコメント参照)

3. 一度だけ認証してリフレッシュトークンを取得する

   ```bash
   npm run auth
   ```

   表示されたURLをブラウザで開いてログイン・許可すると、ターミナルにリフレッシュトークンが表示されるので `.env` の `YOUTUBE_REFRESH_TOKEN` に貼り付ける。

## 動画をアップロードする

```bash
npm run upload -- <動画ファイルパス> --title <仮タイトル> --publishAt <公開予約日時 ISO8601>
```

例:

```bash
npm run upload -- ./shorts.mp4 --title "2026-08-18" --publishAt "2026-08-18T10:45:00Z"
```

- 公開設定は常に「非公開＋公開予約」。タイトル・サムネイル・キャプション・BGMはアップロード後にYouTube Studioで手動設定する。
- `--publishAt` はUTCのISO8601形式。日本時間19:45に公開したい場合は `10:45:00Z` を指定する。

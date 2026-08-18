# note-shorts-uploader

noteの記事に誘導するYouTubeショート動画の「書き出し→アップロード」だけを自動化するツール。

## 運用フロー

1. カード6枚分のテキスト作成とCanvaへの反映は、チャット(Claude)とユーザーの会話で行う。台本作成はこのリポジトリのコードの範囲外。
2. Canva側には固定の2テンプレートがある:
   - 「オレンジ」= 夕焼け海のデザイン (Canva design id: `DAHOTa4n3u4`, タイトル「２・YouTube１分」)
   - 「ダーク」= 満月のデザイン (Canva design id: `DAHN73SIl04`, タイトル「２・YouTube１分のコピー」)
3. ユーザーが「オレンジ(またはダーク)をアップして」と言ったら:
   - Canva MCPツール (`mcp__Canva__export-design`, format: mp4) で該当デザインを書き出す
   - 書き出しURLをダウンロードし、`npm run upload` でYouTubeにアップロードする
   - 仮タイトルはアップロード日付 (例: `2026-08-18`)、公開予約は毎日19:45固定
   - タイトル・サムネイル・キャプション・BGMはユーザーが後からYouTube Studioで手動設定する(このツールの範囲外)

## セットアップ

`.env.example` を `.env` にコピーし、Google Cloud ConsoleでOAuthクライアント(デスクトップアプリ)を作成後、`npm run auth` で一度だけ認証してリフレッシュトークンを取得する。詳細はREADME参照。

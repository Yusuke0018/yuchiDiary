# ゆうちいダイアリー

夫婦専用の毎日記録アプリです。祐介様と千里様が互いに評価と感想を記録し、「ありがとう」を贈り合い、週次AIコメントで温かい振り返りを行えるようにします。

## 構成概要

- **フロントエンド**: Firebase Hosting によるシングルページ。Firebase Authentication / Firestore を直接利用します。
- **データストア**: Cloud Firestore
  - `users` / `agreements` / `days` / `weeklyComments`
  - `days/{day}/entries/{uid}` に日次入力を保存
- **クラウド関数** (`functions/`)
  - `incrementThanks`: ありがとうカウンタの更新（Callable）
  - `syncDayAggregates`: 日次入力の集計同期（Firestore トリガー）
  - `generateWeeklyComment`: 週次AIコメントの自動生成（日曜0:00、Asia/Tokyo）

## セットアップ手順

1. リポジトリをクローンし、ルートで依存関係を導入します。

   ```bash
   npm install
   ```

2. Firebase プロジェクトを作成し、**Authentication** で Google ログインを有効化、Firestore を有効にします。

3. `public/firebase-config.sample.js` を複製し、本番の設定値を記入します。

   ```bash
   cp public/firebase-config.sample.js public/firebase-config.js
   # 値を Firebase コンソールに合わせて修正
   ```

4. `public/app-config.js` の千里様メールアドレス（`REPLACE_WITH_CHII_EMAIL`）を実際のアドレスに置き換えてください。
   Firestore セキュリティルールの該当箇所も同じメールアドレスに更新します。

5. Cloud Functions 用に OpenAI API キーを設定します。

   ```bash
   cp functions/.env.example functions/.env
   # OPENAI_API_KEY と必要であれば OPENAI_MODEL を設定
   ```

6. Firebase CLI でログインし、プロジェクトを紐付けます。

   ```bash
   firebase login
   firebase use YOUR_PROJECT_ID
   ```

7. Firestore ルールとインデックス、クラウド関数、Hosting をデプロイします。

   ```bash
   firebase deploy --only firestore:rules,firestore:indexes,functions,hosting
   ```

## 主要機能

- **夫婦の決め事**: トップ画面に先頭項目を常時表示。ドラッグで順序変更、ピン留め、アーカイブ、編集が可能です。
- **日次スレッド**: 各日につき「祐介」「千里」が評価（1〜4）と感想を入力できます。過去日の編集も可能。0:00〜1:00 の投稿は前日扱い。
- **ありがとうカウンター**: 祐介分・千里分をそれぞれ記録し、Cloud Functions 経由で安全に加算します。取り消しはありません。
- **統計・履歴**: 日/週/月の平均スコアとありがとう数を表示し、週・月推移をグラフ化します。
- **週次AIコメント**: 過去データを参照しつつ毎週日曜0:00に自動生成（約400文字、日本語）。

## 開発用コマンド

- `npm run format` : Prettier でコード整形
- `npm run lint` : ESLint チェック
- `npm test` : 現状は `npm run lint` を呼び出します
- `npm --prefix functions run lint` : Functions ディレクトリのチェック

## 注意事項

- Firestore ルール内、および `public/app-config.js` 内の千里様メールアドレスは必ず実際の値に更新してください。
- OpenAI モデルは `OPENAI_MODEL` 環境変数で上書きできます（既定は `gpt-4.1-mini`）。ChatGPT 5 系列モデルを利用する場合は該当名称に置き換えてください。
- `.codex/logs/` 配下に操作ログを残す運用を想定しています。必要に応じてスクリプト等で記録してください。

---

祐介様と千里様が楽しく続けられるよう、温かみのあるUI/UXとデータモデルで構成しています。必要に応じて機能拡張や通知の再有効化も可能です。

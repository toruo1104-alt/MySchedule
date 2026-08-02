# MySchedule — 導入手順

個人用スケジュール管理Webアプリ。フロント・APIとも **Cloudflare Workers**(Static Assets + D1)で配信し、Googleカレンダー・Google Tasksの読み取りだけは専用のGASプロキシ経由で行う。
仕様は [docs/仕様書.md](docs/仕様書.md)、バックエンドの設計・構築手順は [docs/DB設計.md](docs/DB設計.md)・[docs/構築手順書.md](docs/構築手順書.md) を参照。

アプリURL: **https://myschedule.toruo1104.workers.dev**

## 初回セットアップ

1. https://myschedule.toruo1104.workers.dev を開く(PCでもスマホでもOK。ブックマーク推奨)
2. 初回は「API設定」画面が開くので、API URL(`https://myschedule.toruo1104.workers.dev/api`)と `API_TOKEN` の値を貼り付けて「保存して読み込み」
   ※設定はそのブラウザに保存される(localStorage)。別の端末で使うときは同じ入力を1回行う。トークンを忘れた場合は運用者(自分)がCloudflareダッシュボードのWorkers Secretで確認・再発行する

スマホでは「ホーム画面に追加」でPWAとして起動できる(`web/manifest.webmanifest`)。

## 更新の反映手順(コード修正時)

| 変更対象 | 反映方法 |
|---|---|
| フロント・API(`web/` / `worker/src/*`) | `git push` → `cd worker && npx wrangler deploy` |
| D1スキーマ変更(`worker/migrations/*.sql`) | 新規マイグレーションファイルを追加 → `npx wrangler d1 migrations apply DB --remote` |
| GASプロキシ(`gas/calendar_proxy.gs`) | GASエディタ(プロキシ専用プロジェクト)に貼り替え →「デプロイ」→「デプロイを管理」→ 鉛筆 → バージョン「**新バージョン**」→「デプロイ」(※新バージョンにしないと反映されない) |

構築(初回セットアップ・シークレット設定・D1作成等)の詳細手順は `docs/構築手順書.md` を参照。

## ローカル開発

```
cd worker
npx wrangler d1 migrations apply DB --local
npx wrangler dev --local          # http://localhost:8787 でフロントごと動く
```

- ローカル専用の環境変数は `worker/.dev.vars` に記述する(`.gitignore` 済み)
- `worker/test/smoke.mjs` でAPIの疎通を確認できる(冒頭でローカルD1を初期状態にリセットする点に注意)

GAS・Cloudflareに一切反映せずに見た目・操作だけ確認したい場合は、モックのローカルプレビューも使える(データはブラウザのlocalStorageに保存されるモック):

1. このフォルダで `python -m http.server 8766` を起動(または Claude Code のプレビュー機能で `myschedule-preview`)
2. ブラウザで http://localhost:8766/preview/index.html を開く
3. モックデータをリセットしたいときは DevTools コンソールで `localStorage.removeItem('myschedule-mock')` → リロード

## 使い方(基本操作)

- **塗る**: 上部パレットで区分を選び、グリッドのセルをクリック or 矩形ドラッグ。ST(勉強)・FX(フレックス)は ▾ から内訳を選べる
- **消す**: **同じ区分を選んだまま、塗ってある所をなぞる**と消える(枠が赤くなる)。別区分を選んでなぞれば上書き。🧽消しゴムを使えば区分を問わず消せる
- **元に戻す**: 「↶ 元に戻す」ボタン or Ctrl+Z(直前30操作まで。月を切り替えると履歴は消えます)
- **パレットを隠す**: 「≡ 区分」ボタン(スマホでは最初から畳まれた状態で開きます)
- **日ごとのUB合計**: グリッド最下部に常時表示(スクロールしても固定)
- **メモ**(浜北・char など): セルを**右クリック** → 入力(同じ区分の連続枠にまとめて適用が既定ON)
- **有休・日メモ**(歓迎会など): 日付ヘッダをクリック
- **区分の追加・変更**: 「区分編集」ボタン(コードは追加後変更不可、名称・色などは変更可)
- **API設定のやり直し**: ⚙ボタン
- 保存は自動(右上に保存状態が出る)。設定(表示時間帯・要求時間など)はD1コンソールで直接編集 → アプリをリロード(`docs/構築手順書.md` §5参照)

## 運用・バックアップ

- D1のバックアップ・Time Travelによる復元、区分/設定値の確認SQL等は `docs/構築手順書.md` §5参照
- 移行前のGoogleスプレッドシートは読み取り専用のアーカイブとして温存している(編集しない)

## セキュリティのメモ

- このリポジトリは Public。**コードのみ公開**であり、スケジュールデータ・トークン・API URLは含まれない
- `API_TOKEN` が漏れた場合は、`wrangler secret put API_TOKEN` で値を書き換えれば即無効化できる(アプリ側は⚙から新トークンを入れ直す)

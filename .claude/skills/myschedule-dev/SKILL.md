---
name: myschedule-dev
description: >
  MySchedule(個人スケジュール管理アプリ: GitHub Pages+GAS API+スプレッドシート)の開発時に使う。
  index.html / style.css / app.js / GAS.txt / docs/仕様書.md を触るとき、グリッド・区分・塗り操作・
  集計・保存・祝日・API認証・カレンダー取込に関わる作業のとき、明示的に頼まれていなくても
  積極的に発動すること。
---

# MySchedule 開発ガイド

## 全体像

GitHub Pages(フロント) + GAS JSON API + スプレッドシート(データ)の個人用スケジュール管理アプリ。
**仕様(what)は [docs/仕様書.md](../../../docs/仕様書.md) が正** — コードを変える前に該当節を読む。
特に「3. システム構成・通信(トークン認証)」「5. データモデル(変更禁止事項)」「7. UX統一ルール」は遵守対象。

## 黄金ルール

- **Publicリポジトリ**: トークン・GAS URL・個人データをコード/コミットに絶対に含めない
  (API設定はlocalStorage、トークンは設定シートが正)
- 列の挿入・順序変更は禁止(追加は末尾のみ)。記録A:B・日次A・祝日A列はテキスト書式固定
- 日付は `yyyy-MM-dd`、時刻は `HH:mm` の文字列。Date型を状態に持ち込まない
- 新しい操作を追加するときは保存の型(楽観更新→dirty→デバウンス→ステータス表示)と
  Escルール(最前面から1つずつ閉じる)に乗せてから完成とする
- YAGNI: 頼まれていない抽象化・リファクタはしない
- 機能・パラメータ・色・APIを変えたら仕様書を同じターンで更新する

## 進め方

1. **変更前バックアップ**: 対象ファイルを `old/yyyyMMdd_説明/` にコピーしてから編集(git併用でも従来流儀を維持)
2. **編集**: 大きめの変更は `careful-large-file-edits` の手順(grep→直前Read→一意なold_stringで最小差分)
3. **検証(ローカル)**: プレビューサーバー(`myschedule-preview`、ポート8766)で
   `http://localhost:8766/preview/index.html` を開く。mock.js が `__MYSCHEDULE_MOCK__` でAPIを偽装する
4. **引き渡し**(`change-handoff-checklist` 準拠):
   - フロント変更 → `git add/commit/push`(Pagesに数十秒〜数分で反映。確認はスーパーリロード)
   - `GAS.txt` 変更 → ユーザーにGASエディタへの貼り替え+「デプロイを管理→**新バージョン**」を案内
   - 両方変えたときは両方の手順を明示する

## 既知の落とし穴

- **ブラウザペインの screenshot / computer クリックが効かない環境がある**
  → 症状: screenshot がタイムアウト、left_click が成功表示でもページに届かない
  → 対処: 検証は `javascript_tool` でDOM検査+イベントディスパッチ(`.click()`、MouseEvent)で行い、
    見た目の最終確認はユーザーに依頼する
- **表示/非表示の検証は DOM プロパティだけでは不十分(実バグの反省)**
  → `hidden` 属性は author CSS の `display: flex` に負ける。`el.hidden === true` でも表示され続けうる。
    style.css の `[hidden] { display: none !important; }` を消さないこと。
  → 検証は `getComputedStyle(el).display` と `document.elementFromPoint()`(最前面要素の確認)で行う
- **PowerShell 5.1 の Get-Content は既定でANSI読み** → UTF-8ファイルが文字化けする。
  ファイル生成・変換はWrite/Editツールで行う(シェルのリダイレクトで作らない)
- **GASの新バージョンデプロイ忘れ** → コードを貼り替えても本番に反映されない
- **CORS**: GASへのfetchは `Content-Type: text/plain` を維持すること(preflightに応答できない)。
  ヘッダーを増やしたり application/json にすると通信が失敗する
- **モックのリセット** → `localStorage.removeItem('myschedule-mock')`。API設定のリセット →
  `localStorage.removeItem('myschedule-api')`
- **祝日が出ない** → 本番: 祝日シートの該当年の行を削除して再アクセス(再取得される)。
  モック: mock.js の HOLIDAYS_2026 は2026年分のみハードコード
- **時間帯外の記録**: dayStart前/dayEnd後のスロットは表示されないが集計には含まれる(仕様)
- **入れ子スクロールと `position: sticky`**: `overflow: auto`/`hidden` の内側スクロールコンテナ配下の要素の
  sticky は、外側コンテナのスクロールには追従しない(sticky は最近接スクロールコンテナ基準)。
  週ビューの曜日ヘッダーはこのため JS 疑似 sticky(`translateY` 同期。`syncWeekDayHeaderSticky`)を使っている
- **入れ子スクロールと `scroll-snap`**: `scroll-snap-align`/`scroll-snap-stop` を持つスナップ領域も
  最近接スクロールコンテナに捕捉される。週ビューのスナップマーカー(`.wk-snap-marker`)は必ず
  `.wk-days-scroller` の外(`.wk-hwrap` 直下)に置くこと(内側に置くと縦スナップが黙って無効化される。実際に起きた)

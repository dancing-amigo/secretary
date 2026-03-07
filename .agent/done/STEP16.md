# Step 16: 朝夜ジョブの Cloud Tasks 定時実行化

## 目的
- `morning` / `night` の定時起動を GitHub Actions から Google Cloud Tasks へ移す
- 毎日ローカル時刻 `08:00` と `22:00` に 1 回だけジョブが走るようにする
- 既存の朝夜ジョブ向け window 重複防止ロジックを起動経路から外す

## 方針
- Cloud Tasks は one-off task なので、朝夜ジョブ完了時に翌日分の task を自己再スケジュールする
- アプリ起動時にも次回分 task を seed して、初回デプロイ後も自動で回り続ける状態にする
- delivery 先は既存の `POST /api/jobs/morning` と `POST /api/jobs/night` を再利用する

## 実装項目
1. Cloud Tasks クライアントを event reminder 専用から汎用化し、朝夜ジョブ task を作成できるようにした
2. ローカル timezone 基準で次回 `08:00` / `22:00` を計算し、決定的 task 名で create するようにした
3. `runMorningJob` / `runNightJob` から window reservation を外し、実行後に翌日分を再スケジュールするようにした
4. 起動時に次回朝夜ジョブ task を ensure する bootstrap を追加した
5. GitHub Actions / `node-cron` 前提の README と依存関係を整理した

## 完了条件
- Cloud Tasks だけで朝夜ジョブが継続実行される
- 毎日ローカル `08:00` と `22:00` の task が少なくとも 1 本維持される
- 朝夜ジョブ実行時に window dedupe を参照しない

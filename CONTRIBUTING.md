# コントリビューションガイド

このリポジトリは **GitHub Copilot エージェント（AI）を活用して開発**されます。

---

## 目次

1. [ブランチ戦略](#ブランチ戦略)
2. [開発フロー](#開発フロー)
3. [PRの作成](#prの作成)
4. [AIエージェントの使い方](#aiエージェントの使い方)
5. [CI](#ci)
6. [コーディング規約](#コーディング規約)

---

## ブランチ戦略

```
main
 └── feature/<topic>      新機能の開発
 └── fix/<topic>          バグ修正
 └── copilot/<topic>      AIエージェントによる作業
 └── docs/<topic>         ドキュメント更新
 └── refactor/<topic>     リファクタリング
```

### ルール

- **`main` への直接プッシュは禁止**です。必ずブランチを切ってPRを出してください。
- ブランチ名はスラッシュ区切りの短い説明にしてください（例: `feature/add-zoom-control`）。
- AIエージェントが作業する場合は `copilot/` プレフィックスを使用します。

---

## 開発フロー

```
1. Issue作成  →  2. ブランチ作成  →  3. 開発・コミット  →  4. PR作成  →  5. レビュー  →  6. mainにマージ
```

### ステップ詳細

#### 1. Issue の作成

- 新機能・バグ・AIタスクは必ず Issue を作成してから着手してください。
- Issue には必ず優先度ラベルを **1つだけ** 付けてください：
  - `priority: critical`
  - `priority: high`
  - `priority: medium`
  - `priority: low`
- Issue テンプレートを活用してください：
  - `🐛 バグ報告`
  - `✨ 機能リクエスト`
  - `🤖 AIタスク依頼` ← AIエージェントに作業を依頼する場合はこちら

AIエージェントが Issue を作成する場合も、この優先度ラベル付与を必須とします。

#### 2. ブランチの作成

```bash
# 例
git switch main
git pull origin main
git switch -c feature/add-zoom-control
```

AIエージェントへのタスク依頼は、Issue に `@copilot` でメンションすると、
エージェントが自動的に `copilot/<topic>` ブランチを作成して作業します。

AIエージェントがコードを変更する場合、**ローカルブランチを作成してから作業し、PR作成まで完了すること** を必須とします。ローカル変更だけを残して終了してはいけません。

#### 3. 開発・コミット

- コミットメッセージは変更内容を簡潔に記述してください。
- コンパイルとリントが通ることを確認してください：

```bash
npm run lint
npm run compile
```

#### 4. PR の作成

- `main` をターゲットブランチとして PR を作成してください。
- PR テンプレートのチェックリストをすべて確認してください。
- PR タイトルに変更の種類を示すプレフィックスを付けてください：
  - `feat:` 新機能
  - `fix:` バグ修正
  - `docs:` ドキュメント
  - `refactor:` リファクタリング
  - `chore:` 設定・環境

#### 5. レビューとマージ

- CI（lint + compile）がすべてパスしていることを確認してください。
- レビュー後に `main` にスカッシュマージします。

---

## PR の作成

PRを作成する際は `.github/PULL_REQUEST_TEMPLATE.md` のチェックリストに従ってください。

---

## AIエージェントの使い方

### GitHub Copilot エージェントへのタスク依頼

1. `🤖 AIタスク依頼` テンプレートで Issue を作成する。
2. Issue 内で `@copilot` にメンションしてタスクを依頼する。
3. Copilot エージェントが `copilot/<topic>` ブランチを作成し、作業を開始する。
4. コードを変更した場合、エージェントはローカルブランチ上でコミットし、ブランチを push して PR を作成する。
5. PR をレビューし、問題がなければ `main` にマージする。

### エージェント環境のカスタマイズ

`.github/workflows/copilot-setup-steps.yml` を編集することで、
Copilot エージェントの実行環境をカスタマイズできます（Node.js バージョン、依存パッケージのキャッシュ等）。

このファイルは `ci.yml` の代替ではありません。`ci.yml` は PR や push 時の検証用、
`copilot-setup-steps.yml` は Copilot エージェントの作業セッション内で
`npm run lint` や `npm run compile` を実行できる状態を作るための専用設定です。

また、ジョブ名 `copilot-setup-steps` は Copilot が認識する予約名のため、
AI エージェントによる開発フローを維持する限り削除・改名しないでください。

---

## CI

`.github/workflows/ci.yml` により、以下のブランチへの push および `main` への PR 時に自動的に実行されます：

| チェック | コマンド |
|---|---|
| Lint | `npm run lint` |
| Compile | `npm run compile` |

PRをマージする前に、すべての CI チェックがパスしていることを確認してください。

---

## リリース手順

このプロジェクトはGit タグをトリガーに、自動的に GitHub Releases へ VSIX ファイルをアップロードします。

### リリースの切り方

1. `main` ブランチが最新で、すべての変更がコミット・プッシュされていることを確認してください。

2. バージョンタグを作成してプッシュします：

```bash
# 例: v0.0.2 をリリースする場合
git tag v0.0.2
git push origin v0.0.2
```

3. GitHub Actions の `release.yml` ワークフローが自動実行され、以下が実行されます：
   - Lint・Compile チェック
   - VSIX ファイル生成
   - GitHub Release 作成
   - VSIX ファイルをリリースアセットとしてアップロード

4. [GitHub Releases](../../releases) ページで、リリースが表示されることを確認してください。

### バージョニング規則

- タグ形式は `v<major>.<minor>.<patch>` です（例：`v1.0.0`）。
- **Git タグはバージョン管理の source of truth** です。タグとリリースノートは対応します。
- `package.json` 内の version フィールドは参考値として扱われます。VSIX ファイル名生成に使用されます。

### ユーザーがインストールする方法

1. [GitHub Releases](../../releases) ページから最新の `.vsix` ファイルをダウンロードしてください。
2. VS Code で **Extensions: Install from VSIX...** コマンドを実行し、ダウンロードした VSIX ファイルを指定してください。

---

## コーディング規約

- TypeScript を使用してください。
- `eslint.config.mjs` に定義されたルールに従ってください（`npm run lint` で確認）。
- `tsconfig.json` の設定に従ってください。

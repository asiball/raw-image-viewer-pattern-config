# コントリビューションガイド / Contributing Guide

このリポジトリは **GitHub Copilot エージェント（AI）を活用して開発**されます。  
This repository is developed using **GitHub Copilot agent (AI)**.

---

## 目次 / Table of Contents

1. [ブランチ戦略 / Branch Strategy](#ブランチ戦略--branch-strategy)
2. [開発フロー / Development Flow](#開発フロー--development-flow)
3. [PRの作成 / Creating a Pull Request](#prの作成--creating-a-pull-request)
4. [AIエージェントの使い方 / Using the AI Agent](#aiエージェントの使い方--using-the-ai-agent)
5. [CI / Continuous Integration](#ci--continuous-integration)
6. [コーディング規約 / Coding Standards](#コーディング規約--coding-standards)

---

## ブランチ戦略 / Branch Strategy

```
main
 └── feature/<topic>      新機能の開発 / New feature development
 └── fix/<topic>          バグ修正 / Bug fix
 └── copilot/<topic>      AIエージェントによる作業 / AI agent work
 └── docs/<topic>         ドキュメント更新 / Documentation updates
 └── refactor/<topic>     リファクタリング / Refactoring
```

### ルール / Rules

- **`main` への直接プッシュは禁止**です。必ずブランチを切ってPRを出してください。  
  **Direct pushes to `main` are not allowed.** Always create a branch and open a PR.
- ブランチ名はスラッシュ区切りの短い説明にしてください（例: `feature/add-zoom-control`）。  
  Branch names should use slash-separated short descriptions (e.g., `feature/add-zoom-control`).
- AIエージェントが作業する場合は `copilot/` プレフィックスを使用します。  
  When the AI agent works on a task, use the `copilot/` prefix.

---

## 開発フロー / Development Flow

```
1. Issue作成  →  2. ブランチ作成  →  3. 開発・コミット  →  4. PR作成  →  5. レビュー  →  6. mainにマージ
   Create Issue    Create Branch      Develop & Commit    Open PR         Review          Merge to main
```

### ステップ詳細 / Step Details

#### 1. Issue の作成 / Create an Issue

- 新機能・バグ・AIタスクは必ず Issue を作成してから着手してください。  
  Always create an Issue before starting work on a new feature, bug, or AI task.
- Issue テンプレートを活用してください：  
  Use the Issue templates:
  - `🐛 バグ報告 / Bug Report`
  - `✨ 機能リクエスト / Feature Request`
  - `🤖 AIタスク依頼 / AI Task Request` ← AIエージェントに作業を依頼する場合はこちら

#### 2. ブランチの作成 / Create a Branch

```bash
# 例 / Example
git switch main
git pull origin main
git switch -c feature/add-zoom-control
```

AIエージェントへのタスク依頼は、Issue に `@copilot` でメンションすると、  
エージェントが自動的に `copilot/<topic>` ブランチを作成して作業します。

When you mention `@copilot` in an Issue, the agent will automatically create a `copilot/<topic>` branch and start working.

#### 3. 開発・コミット / Develop and Commit

- コミットメッセージは変更内容を簡潔に記述してください。  
  Write concise commit messages describing the changes.
- コンパイルとリントが通ることを確認してください：  
  Ensure compile and lint pass:

```bash
npm run lint
npm run compile
```

#### 4. PR の作成 / Open a Pull Request

- `main` をターゲットブランチとして PR を作成してください。  
  Create a PR targeting the `main` branch.
- PR テンプレートのチェックリストをすべて確認してください。  
  Fill in all items in the PR template checklist.
- PR タイトルに変更の種類を示すプレフィックスを付けてください：  
  Add a prefix to the PR title indicating the type of change:
  - `feat:` 新機能 / New feature
  - `fix:` バグ修正 / Bug fix
  - `docs:` ドキュメント / Documentation
  - `refactor:` リファクタリング / Refactoring
  - `chore:` 設定・環境 / Configuration / Infrastructure

#### 5. レビューとマージ / Review and Merge

- CI（lint + compile）がすべてパスしていることを確認してください。  
  Ensure all CI checks (lint + compile) pass.
- レビュー後に `main` にスカッシュマージします。  
  Squash merge into `main` after review.

---

## PR の作成 / Creating a Pull Request

PRを作成する際は `.github/PULL_REQUEST_TEMPLATE.md` のチェックリストに従ってください。  
When creating a PR, follow the checklist in `.github/PULL_REQUEST_TEMPLATE.md`.

---

## AIエージェントの使い方 / Using the AI Agent

### GitHub Copilot エージェントへのタスク依頼

1. `🤖 AIタスク依頼 / AI Task Request` テンプレートで Issue を作成する。  
   Create an Issue using the `🤖 AI Task Request` template.
2. Issue 内で `@copilot` にメンションしてタスクを依頼する。  
   Mention `@copilot` in the Issue to request the task.
3. Copilot エージェントが `copilot/<topic>` ブランチを作成し、作業を開始する。  
   The Copilot agent will create a `copilot/<topic>` branch and begin work.
4. 作業完了後、エージェントが PR を作成する。  
   After work is complete, the agent opens a PR.
5. PR をレビューし、問題がなければ `main` にマージする。  
   Review the PR and merge into `main` if everything looks good.

### エージェント環境のカスタマイズ / Agent Environment Customization

`.github/workflows/copilot-setup-steps.yml` を編集することで、  
Copilot エージェントの実行環境をカスタマイズできます（Node.js バージョン、依存パッケージのキャッシュ等）。  

You can customize the Copilot agent's environment by editing `.github/workflows/copilot-setup-steps.yml`  
(Node.js version, dependency caching, etc.).

---

## CI / Continuous Integration

`.github/workflows/ci.yml` により、以下のブランチへの push および `main` への PR 時に自動的に実行されます：  
The following checks run automatically on push to feature/fix/copilot branches and on PRs to `main`:

| チェック / Check | コマンド / Command |
|---|---|
| Lint | `npm run lint` |
| Compile | `npm run compile` |

PRをマージする前に、すべての CI チェックがパスしていることを確認してください。  
Ensure all CI checks pass before merging a PR.

---

## コーディング規約 / Coding Standards

- TypeScript を使用してください。  
  Use TypeScript.
- `eslint.config.mjs` に定義されたルールに従ってください（`npm run lint` で確認）。  
  Follow the rules defined in `eslint.config.mjs` (verified by `npm run lint`).
- `tsconfig.json` の設定に従ってください。  
  Follow the settings in `tsconfig.json`.

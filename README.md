# 📬 Job Application Tracker (Gmail → Notion + AI)

A personal project that automates tracking of your job applications:

* Detects **job application confirmation emails** in Gmail.
* Extracts the **company name** using Google’s **Gemini LLM**.
* Stores structured data into a **Notion database** (Company, Subject, Date, Status, Body).
* Handles deduplication, polling, and resilience (e.g., cron-job.org timeouts).

---

## 🚀 Features

* **Supabase PostgreSQL** → secure storage for Google OAuth tokens.
* **Gmail API + History API checkpointing** → ensures only *new emails* are processed.
* **Regex-based classification** → only job confirmation emails are considered.
* **Gemini LLM** → extracts company names from varied email formats.
* **Notion API** → stores entries in your personal Job Tracking DB.
* **Cron integration** → fetch new emails every 5 minutes automatically.
* **Background processing** → avoids cron-job.org 30s timeout issues.

---

## 🛠️ Setup Instructions

### 1. Database (Supabase PostgreSQL)

1. Create a new project in [Supabase](https://supabase.com/).
2. Create the `users` table:

```sql
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  access_token text,
  refresh_token text,
  expiry_date bigint,
  token_type text,
  last_history_id text,
  created_at timestamptz default now()
);
```

3. Save your **DB connection string**.
   In `.env`:

   ```bash
   DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE
   ```

---

### 2. Google OAuth2

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project → Enable **Gmail API**.
3. Create OAuth2 credentials (Web App).

   * Redirect URI: `http://localhost:3000/auth/callback`
4. Save your credentials in `.env`:

   ```bash
   GOOGLE_CLIENT_ID=your-client-id
   GOOGLE_CLIENT_SECRET=your-client-secret
   GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback
   ```

Scopes required:

```text
https://www.googleapis.com/auth/gmail.readonly
```

---

### 3. Gemini API Key

1. Get a key from [Google AI Studio](https://aistudio.google.com/).
2. Add to `.env`:

   ```bash
   GEMINI_API_KEY=your-gemini-key
   ```

---

### 4. Notion API

1. Go to [Notion Developers](https://developers.notion.com/).
2. Create an **integration** and get your **Notion Secret**.
3. Share your **database** with that integration.
4. Add to `.env`:

   ```bash
   NOTION_SECRET=your-notion-secret
   NOTION_DATABASE_ID=your-database-id
   ```

Database schema:

* **Company Name** (Title)
* **Email Subject** (Text)
* **Date received** (Date)
* **Referral?** (Text)
* **Email Body** (Text)
* **Status** (Status)
* **Gmail Message ID** (ID)

---

## Application Flow

### 1. Email Fetching

* The app queries Gmail using the **History API**.
* Each user has a `last_history_id` stored in Supabase.
* On each poll, Gmail returns *only new messages since last checkpoint*.
* After processing, `last_history_id` is updated → prevents duplicates.

---

### 2. Email Filtering (Regex Classification)

* We don’t want newsletters, alerts, or promos.
* Emails must match one of these confirmation patterns:

  * `thank you for applying`
  * `thanks for applying`
  * `application received`
  * `application was sent`
  * `received your application`
  * `application was submitted`
* Regex ensures only true confirmations are processed.

---

### 3. Company Extraction (Gemini)

* Regex can’t reliably extract company names → wording varies.
* We use Gemini LLM (`generateContent`) to parse subject + snippet + sender.
* If Gemini fails → fallback = `"Unknown Company"`.

---

### 4. Storing to Notion

* Each new email is logged into Notion DB.
* Deduplication is automatic because `Gmail Message ID` is unique.

---

### 5. Cron Job Polling

* The app is deployed on **Render** free tier.
* **cron-job.org** pings `/emails?email=your-email` every 5 minutes.
* Each ping:

  1. Responds immediately with `202 Accepted` (fast-ACK).
  2. Processes emails **in the background**.

---

### 6. Handling Cron-Job.org 30s Timeout

* cron-job.org has a **hard 30s limit**.
* To avoid timeouts:

  * Route responds instantly.
  * Work continues in background worker (`processEmailsForUser`).
  * An **in-memory lock** prevents overlapping runs.
* This ensures no lost or duplicate emails.

---

## Example Flow

1. You apply to Amazon → Gmail receives “Thank you for applying” email.
2. Cron pings `/emails`.
3. Gmail History API → finds new message ID.
4. Regex → confirms it’s an application confirmation.
5. Gemini → extracts “Amazon”.
6. Entry is written to Notion DB:
   Company: Amazon
   Subject: Thank you for applying
   Date: 2025-08-28
   Referral: No
   Status: Applied
   Gmail Message ID: 198ec6638a69b9ed
   

7. `last_history_id` updated.

---

## Running Locally


git clone https://github.com/yourusername/job-tracker.git
cd job-tracker
npm install
npm run dev

---

## Why Build This Yourself (and not Zapier/n8n)?

* Zapier: limited free tier, 15 min polling, costs \$20+/mo for real use.
* n8n: self-host required, still needs infra.
* Custom app: full control, **free**, and a way to practice **real backend/system design challenges**:

  * Gmail API quota handling
  * Background workers & cron resilience
  * Regex + LLM hybrid classification
  * API integration across 4 platforms (Google, Supabase, Gemini, Notion)

---

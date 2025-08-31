const express = require("express");
const router = express.Router();
const { google } = require("googleapis");
const pool = require("../config/supabase");

const { extractCompany } = require("../utils/geminiParser");
const { addToNotion } = require("../utils/notion");
const { oauth2Client } = require("../config/googleAuth");

// Extract a specific header from message
function getHeader(payload, name) {
  const header = payload.headers.find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  );
  return header?.value || "";
}

function isApplicationConfirmation(subject = "", body = "") {
  const normalize = (s) =>
    String(s || "")
      .replace(/<[^>]+>/g, " ") // strip tags
      .replace(/&nbsp;|&#160;/g, " ")
      .replace(/&quot;|&#34;/g, '"')
      .replace(/[“”]/g, '"') // smart quotes → "
      .replace(/[’]/g, "'") // curly apostrophe → '
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const hay = normalize(`${subject}\n${body}`);

  // Positive phrases (six phrases + a common variant)
  const POS = [
    /\bthank\s*you\s*for\s*apply(?:ing)?\b/i,
    /\bthanks?\s*for\s*apply(?:ing)?\b/i,
    /\bapplication(?:\s+(?:has|have)\s+been)?\s*received\b/i,
    /\bapplication\s+(?:was|has\s+been)\s*sent\b/i,
    /\breceived\s+your\s+application\b/i,
    /\bapplication\s+(?:was|has\s+been)\s*submitted\b/i,
    /\bthank\s*you\s*for\s*your\s*application\b/i, // extra common variant
  ];

  // Noise to skip (alerts, newsletters, feeds, system notices)
  const NEG = [
    /\bjob\s+alert\b/i,
    /\bsaved\s+search\b/i,
    /\bnewsletter\b|\bdigest\b/i,
    /\bnew\s+jobs\b|\bjobs\s+for\s+you\b|\bhiring\s+now\b/i,
    /\bwebinar\b|\bagenda\b|\bevent\b/i,
    /\breport(s)?\s+for\b/i,
    /\bserver\s+failure\b|\bcron(job)?\s+failed\b|\bactivate\s+account\b/i,
    /(^|[\s])["“][^"”]+["”]:\s/i, // “software engineer”: Company (job feeds)
  ];

  const positive = POS.some((re) => re.test(hay));
  if (!positive) return false;

  const negative = NEG.some((re) => re.test(hay));
  return !negative;
}

// simple in-memory lock to prevent overlapping runs (fine for single-user)
let isProcessing = false;

async function processEmailsForUser(email) {
  if (isProcessing) {
    console.log("Skip: a previous run is still in progress.");
    return;
  }
  isProcessing = true;

  try {
    // 1) Load user + tokens
    const { rows } = await pool.query("SELECT * FROM users WHERE email=$1", [
      email,
    ]);
    if (rows.length === 0) {
      console.warn("User not found:", email);
      return;
    }
    const user = rows[0];

    oauth2Client.setCredentials({
      access_token: user.access_token,
      refresh_token: user.refresh_token,
      expiry_date: user.expiry_date,
      token_type: user.token_type,
    });
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // 2) Bootstrap last_history_id (no content filter — just start 'now')
    if (!user.last_history_id) {
      const latest = await gmail.users.messages.list({
        userId: "me",
        labelIds: ["INBOX"],
        q: "-from:me",
        maxResults: 1,
      });

      if (!latest.data.messages || latest.data.messages.length === 0) {
        console.log("No messages in INBOX to bootstrap from.");
        return;
      }

      const latestMsg = await gmail.users.messages.get({
        userId: "me",
        id: latest.data.messages[0].id,
        format: "metadata",
      });

      const initialHistoryId = latestMsg.data.historyId;
      await pool.query(
        `UPDATE users SET last_history_id = $1 WHERE email = $2`,
        [initialHistoryId, email]
      );
      console.log("History tracking initialized at", initialHistoryId);
      return; // bootstrap done; next cron will process from here
    }

    // 3) Get new messages since checkpoint
    const historyRes = await gmail.users.history.list({
      userId: "me",
      startHistoryId: user.last_history_id,
      labelId: "INBOX",
      historyTypes: ["messageAdded"],
    });

    const history = historyRes.data.history || [];
    console.log("history", history);
    const messageIds = [];
    let maxHistoryId = BigInt(user.last_history_id);

    for (const record of history) {
      if (record.id) {
        const hId = BigInt(record.id);
        if (hId > maxHistoryId) maxHistoryId = hId;
      }
      for (const entry of record.messagesAdded || []) {
        if (entry.message?.id) messageIds.push(entry.message.id);
      }
    }
    console.log("after looking through all new records", maxHistoryId);

    if (messageIds.length === 0) {
      console.log("No new messages.");
      return;
    }

    // 4) Process only confirmation emails
    let processed = 0;
    for (const id of messageIds) {
      const full = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "full",
      });

      const snippet = full.data.snippet || "";
      const date = Number(full.data.internalDate);
      const subject = getHeader(full.data.payload, "Subject") || "";
      const from = getHeader(full.data.payload, "From") || "";

      // Filter: only job application confirmations
      if (!isApplicationConfirmation(subject, snippet)) continue;

      let company = "Unknown Company";
      try {
        const { company: extractedCompany } = await extractCompany(
          snippet,
          subject,
          from
        );
        if (extractedCompany) company = extractedCompany;
      } catch (err) {
        console.error("Gemini failed, using default company:", err.message);
      }

      try {
        await addToNotion({
          company,
          subject,
          date,
          referral: "No",
          body: snippet,
          status: "Applied",
          gmailMessageId: id,
        });
        processed++;
      } catch (e) {
        console.error("Notion insert failed:", e?.message || e);
      }
    }

    // 5) Advance checkpoint once (even if processed==0; we still consumed history)
    await pool.query(`UPDATE users SET last_history_id = $1 WHERE email = $2`, [
      maxHistoryId.toString(),
      email,
    ]);
    console.log(
      `Done. Processed ${processed} confirmation email(s). checkpoint=${maxHistoryId}`
    );
  } catch (err) {
    console.error("Background processing failed:", err);
  } finally {
    isProcessing = false;
  }
}

// GET /emails?email=youremail@gmail.com
router.get("/emails", async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).send("Missing email");

  res.status(202).send("Emails processed.");

  setImmediate(() => {
    processEmailsForUser(email).catch((err) =>
      console.error("Unhandled in processEmailsForUser:", err)
    );
  });
});

module.exports = router;

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

// GET /emails?email=youremail@gmail.com
router.get("/emails", async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).send("Missing email");

  try {
    // 1. Get user tokens + last_history_id
    const { rows } = await pool.query("SELECT * FROM users WHERE email=$1", [
      email,
    ]);
    if (rows.length === 0) return res.status(404).send("User not found");
    const user = rows[0];

    oauth2Client.setCredentials({
      access_token: user.access_token,
      refresh_token: user.refresh_token,
      expiry_date: user.expiry_date,
      token_type: user.token_type,
    });

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // 2. Bootstrap historyId if needed
    if (!user.last_history_id) {
      const latest = await gmail.users.messages.list({
        userId: "me",
        labelIds: ["INBOX"],
        q: `-from:me ("thank you for applying" OR "thanks for applying" OR "application received" OR "application was sent" OR "received your application" OR "application was submitted")`,
        maxResults: 1,
      });

      if (!latest.data.messages || latest.data.messages.length === 0) {
        return res.json([]);
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

      return res.status(200).send("✅ History tracking initialized.");
    }

    // 3. Use history.list to get new messages
    const historyRes = await gmail.users.history.list({
      userId: "me",
      startHistoryId: user.last_history_id,
      labelId: "INBOX",
      historyTypes: ["messageAdded"],
    });

    const history = historyRes.data.history || [];
    const messageIds = [];
    let maxHistoryId = BigInt(user.last_history_id);

    for (const record of history) {
      if (record.historyId) {
        const hId = BigInt(record.historyId);
        if (hId > maxHistoryId) maxHistoryId = hId;
      }
      for (const entry of record.messagesAdded || []) {
        if (entry.message?.id) {
          messageIds.push(entry.message.id);
        }
      }
    }

    if (messageIds.length === 0) {
      return res.status(200).json([]);
    }

    const results = [];

    for (const id of messageIds) {
      const full = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "full",
      });

      const snippet = full.data.snippet;
      const date = Number(full.data.internalDate);
      const subject = getHeader(full.data.payload, "Subject");
      const from = getHeader(full.data.payload, "From");

      // Run Gemini to extract company
      let company = "Unknown Company";
      try {
        const { company: extractedCompany } = await extractCompany(
          snippet,
          subject,
          from
        );
        if (extractedCompany) company = extractedCompany;
      } catch (err) {
        console.error("❌ Gemini failed, using default company:", err.message);
      }

      await addToNotion({
        company: company || "Unknown Company",
        subject,
        date,
        referral: "No",
        body: snippet,
        status: "Applied",
        gmailMessageId: id,
      });

      // (Optional)
      //   results.push({
      //     id,
      //     company: company || "Unknown Company",
      //     subject,
      //     date,
      //     referral: "No",
      //     body: snippet,
      //     status: "Applied",
      //   });
      // }

      // 4. Update last_history_id in DB
      await pool.query(
        `UPDATE users SET last_history_id = $1 WHERE email = $2`,
        [maxHistoryId.toString(), email]
      );

      res.status(200).json({ message: "Success" });
    }
  } catch (err) {
    console.error("❌ Failed to fetch emails:", err);
    res.status(500).send("Something went wrong");
  }
});

module.exports = router;

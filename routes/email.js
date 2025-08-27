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

// function isApplicationConfirmation(subject = "", body = "") {
//   const normalize = (s) =>
//     s
//       .replace(/<[^>]+>/g, " ")               // strip tags
//       .replace(/&nbsp;|&#160;/g, " ")
//       .replace(/&quot;|&#34;/g, '"')
//       .replace(/[“”]/g, '"')                  // smart quotes -> "
//       .replace(/\s+/g, " ")
//       .trim()
//       .toLowerCase();

//   const hay = normalize(`${subject}\n${body}`);

//   // Strong positive patterns (confirmation language)
//   const POS = [
//     // "thank you for applying"
//     /\bthank\s*you\s*for\s*apply(?:ing)?\b/i,

//     // "thanks for applying"
//     /\bthanks?\s*for\s*apply(?:ing)?\b/i,

//     // "application received" (also catches "application has been received")
//     /\bapplication(?:\s+(?:has|have)\s+been)?\s*received\b/i,

//     // "application was sent" (also "has been sent")
//     /\bapplication\s+(?:was|has\s+been)\s*sent\b/i,

//     // "received your application"
//     /\breceived\s+your\s+application\b/i,

//     // "application was submitted" (also "has been submitted")
//     /\bapplication\s+(?:was|has\s+been)\s*submitted\b/i,
//   ];

//   // Common negatives (alerts, newsletters, job feeds, promos)
//   const NEG = [
//     /\bjob\s+alert\b/i,
//     /\bsaved\s+search\b/i,
//     /\bnewsletter\b|\bdigest\b/i,
//     /\bnew\s+jobs\b|\bjobs\s+for\s+you\b|\bhiring\s+now\b/i,
//     /\bwebinar\b|\bagenda\b|\bevent\b/i,
//     /\breport(s)?\s+for\b/i,
//     /\bserver\s+failure\b|\bcron(job)?\s+failed\b|\bactivate\s+account\b/i,
//     // subjects like “software engineer”: Company — common job-feed format
//     /(^|[\s])["“][^"”]+["”]:\s/i,
//   ];

//   const positive = POS.some((re) => re.test(hay));
//   const negative = NEG.some((re) => re.test(hay));
//   return positive && !negative;
// }

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

  // Positive phrases (your six + a common variant)
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

    // 2. Checking if user has a last_history_id associated with their email, if not performing steps to get the last_history_id
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

    // 3. Use history.list to get new messages from the last checkpoint (last_history_id)
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
      //Calculating the max history id among all the new emails and updating maxHistoryId
      if (record.historyId) {
        const hId = BigInt(record.historyId);
        if (hId > maxHistoryId) maxHistoryId = hId;
      }
      //Getting the message ids of all the new emails
      for (const entry of record.messagesAdded || []) {
        if (entry.message?.id) {
          messageIds.push(entry.message.id);
        }
      }
    }

    if (messageIds.length === 0) {
      return res.status(200).send("✅ No new emails.");
    }

    // 4. For each new email, get the full message details and extract the company
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

      // Skip anything that isn't an application confirmation
      if (!isApplicationConfirmation(subject, snippet)) {
        continue;
      }

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
    }

    // 4. Update last_history_id in DB
    await pool.query(`UPDATE users SET last_history_id = $1 WHERE email = $2`, [
      maxHistoryId.toString(),
      email,
    ]);
  } catch (err) {
    console.error("❌ Failed to fetch emails:", err);
    res.status(500).send("Something went wrong");
  }

  return res.status(200).send("✅ Emails processed.");
});

module.exports = router;

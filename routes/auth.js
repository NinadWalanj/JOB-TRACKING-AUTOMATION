const express = require("express");
const router = express.Router();
const { google } = require("googleapis");
const { oauth2Client, getAuthUrl } = require("../config/googleAuth");
const pool = require("../config/supabase");

// GET /auth - Redirect to Google OAuth consent screen
router.get("/auth", (_req, res) => {
  const url = getAuthUrl();
  res.redirect(url);
});

// GET /oauth2callback - Handle Google redirect
router.get("/oauth2callback", async (req, res) => {
  const code = req.query.code;

  try {
    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user's Gmail address
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress;

    // Store tokens in Supabase (Postgres)
    await pool.query(
      `
      INSERT INTO users (email, access_token, refresh_token, expiry_date, token_type)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (email) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = COALESCE(EXCLUDED.refresh_token, users.refresh_token),
        expiry_date = EXCLUDED.expiry_date,
        token_type = EXCLUDED.token_type,
        created_at = NOW()
      `,
      [
        email,
        tokens.access_token || null,
        tokens.refresh_token || null,
        tokens.expiry_date || null,
        tokens.token_type || null,
      ]
    );

    // Auto-refresh tokens and update DB when needed
    oauth2Client.on("tokens", async (tokens) => {
      if (tokens.access_token) {
        await pool.query(
          `UPDATE users SET access_token = $1, expiry_date = $2, created_at = NOW() WHERE email = $3`,
          [tokens.access_token, tokens.expiry_date || null, email]
        );
      }
    });

    res.send(`✅ Gmail access granted for ${email}`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("Authentication failed.");
  }
});

module.exports = router;
